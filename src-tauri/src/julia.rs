use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;

// ── Input validation helpers (defense-in-depth) ───────────────────────

/// Validate a Julia package name.
/// Must start with a letter and contain only ASCII letters, digits, or underscores.
fn validate_package_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Package name must not be empty".into());
    }
    let valid = name.starts_with(|c: char| c.is_ascii_alphabetic())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !valid {
        return Err(format!(
            "Invalid package name '{}': must start with a letter and contain only ASCII letters, digits, or underscores",
            name
        ));
    }
    Ok(())
}

/// Validate that a path does not contain null bytes or ASCII control characters.
pub(crate) fn validate_path(path: &str, label: &str) -> Result<(), String> {
    if path.contains('\0') {
        return Err(format!("{} must not contain null bytes", label));
    }
    if path.chars().any(|c| c.is_ascii_control() && c != '\t') {
        return Err(format!("{} must not contain control characters", label));
    }
    Ok(())
}

/// Validate a general user string (username, author, etc.).
/// Rejects empty strings, null bytes, and most control chars.
fn validate_user_string(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{} must not be empty", label));
    }
    if value.contains('\0') {
        return Err(format!("{} must not contain null bytes", label));
    }
    if value
        .chars()
        .any(|c| c.is_ascii_control() && c != '\n' && c != '\t')
    {
        return Err(format!("{} must not contain control characters", label));
    }
    Ok(())
}

#[derive(Debug, Default)]
pub struct JuliaState {
    pub process_pid: Option<u32>,
}

pub type SharedJuliaState = Arc<Mutex<JuliaState>>;

pub fn new_julia_state() -> SharedJuliaState {
    Arc::new(Mutex::new(JuliaState::default()))
}

#[derive(Clone, Serialize, Deserialize)]
pub struct JuliaOutputEvent {
    pub kind: String, // "stdout" | "stderr" | "done" | "error"
    pub text: String,
    pub exit_code: Option<i32>,
}

/// Tokio `lines()` leaves a trailing `\r` when the child uses CRLF (typical on Windows).
/// Stripping it keeps `%%JULIDE_MIME%%…%%` detection and Monaco inline widgets correct.
#[inline]
pub(crate) fn normalize_julia_stdio_line(mut line: String) -> String {
    while line.ends_with('\r') {
        line.pop();
    }
    line
}

/// Windows `CREATE_NO_WINDOW`: start the child without a console of its own.
///
/// julIDE is built with `windows_subsystem = "windows"`, so it has no console
/// to lend. A console-subsystem program — `julia`, `cmd`, `taskkill` — launched
/// from it gets one allocated, and that is a black box flashing on screen.
/// Redirecting the child's stdio does not prevent it; only this flag does.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Apply [`CREATE_NO_WINDOW`] to an async child.
///
/// A no-op off Windows, so call sites need no `#[cfg]` of their own — which is
/// exactly how `julia_precompile`, `julia_pkg_add` and `julia_pkg_rm` came to
/// be spawning with a visible console while every command around them hid it.
pub(crate) fn hide_console(cmd: &mut tokio::process::Command) -> &mut tokio::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// The same, for a blocking child.
///
/// Windows-only, unlike [`hide_console`]: every blocking spawn julIDE makes is
/// a Windows-specific one (`cmd /C where julia`, `taskkill`) and already sits
/// inside a `#[cfg(windows)]` block.
#[cfg(windows)]
pub(crate) fn hide_console_sync(cmd: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

static JULIA_PATH: Lazy<Arc<Mutex<Option<PathBuf>>>> = Lazy::new(|| Arc::new(Mutex::new(None)));

/// Find the Julia executable, trying multiple strategies.
pub async fn find_julia() -> Option<PathBuf> {
    let cached = JULIA_PATH.lock().await;
    if let Some(ref p) = *cached {
        return Some(p.clone());
    }
    drop(cached);

    let found = find_julia_impl();

    if let Some(ref p) = found {
        let mut cached = JULIA_PATH.lock().await;
        *cached = Some(p.clone());
    }
    found
}

/// The `Program Files` roots to scan, in order and without repeats.
///
/// Kept separate from the environment lookup so the ordering and the
/// de-duplication can be tested on a machine that has none of these variables —
/// which is every machine CI has ever run this on.
#[cfg(any(windows, test))]
fn program_files_roots_from(vars: [Option<String>; 3]) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for value in vars.into_iter().flatten() {
        if value.is_empty() {
            continue;
        }
        let root = PathBuf::from(value);
        if !roots.contains(&root) {
            roots.push(root);
        }
    }
    roots
}

/// `%ProgramW6432%` first: it names the 64-bit tree even from a 32-bit process,
/// where `%ProgramFiles%` is redirected to the x86 one.
#[cfg(windows)]
fn program_files_roots() -> Vec<PathBuf> {
    program_files_roots_from([
        std::env::var("ProgramW6432").ok(),
        std::env::var("ProgramFiles").ok(),
        std::env::var("ProgramFiles(x86)").ok(),
    ])
}

fn find_julia_impl() -> Option<PathBuf> {
    // 0. Check settings-persisted julia_path (highest priority)
    {
        let settings = crate::settings::settings_load();
        if !settings.julia_path.is_empty() {
            let p = PathBuf::from(&settings.julia_path);
            if p.exists() {
                return Some(p);
            }
        }
    }

    // 1. Explicit env var override
    if let Ok(path) = std::env::var("JULIA_PATH") {
        let p = PathBuf::from(&path);
        if p.exists() {
            return Some(p);
        }
    }

    // 2. PATH lookup via shell
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        if let Ok(output) = std::process::Command::new(&shell)
            .args(["-l", "-c", "which julia"])
            .output()
        {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let p = PathBuf::from(&path);
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/C", "where julia"]);
        hide_console_sync(&mut cmd);
        if let Ok(output) = cmd.output() {
            if output.status.success() {
                // `where` may return multiple lines; take the first
                let path = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let p = PathBuf::from(&path);
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }

    // 3. juliaup default location
    #[cfg(unix)]
    {
        if let Some(home) = dirs::home_dir() {
            let p = home.join(".juliaup/bin/julia");
            if p.exists() {
                return Some(p);
            }
        }
    }
    #[cfg(windows)]
    {
        if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
            let p = PathBuf::from(&localappdata).join("juliaup\\bin\\julia.exe");
            if p.exists() {
                return Some(p);
            }
        }
    }

    // 4. Common static paths
    #[cfg(unix)]
    {
        for candidate in &[
            "/opt/homebrew/bin/julia",
            "/usr/local/bin/julia",
            "/usr/bin/julia",
        ] {
            let p = PathBuf::from(candidate);
            if p.exists() {
                return Some(p);
            }
        }
    }
    #[cfg(windows)]
    {
        // Check common Windows install locations
        if let Ok(localappdata) = std::env::var("LOCALAPPDATA") {
            // Scan LocalAppData\Programs for Julia-* directories
            let programs = PathBuf::from(&localappdata).join("Programs");
            if let Ok(entries) = std::fs::read_dir(&programs) {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let name_str = name.to_string_lossy();
                    if name_str.starts_with("Julia") && entry.path().is_dir() {
                        let bin = entry.path().join("bin\\julia.exe");
                        if bin.exists() {
                            return Some(bin);
                        }
                    }
                }
            }
        }
        // Also check Program Files. Read from the environment rather than
        // spelled out: Windows is not always installed on C:, and a 32-bit
        // process sees `%ProgramFiles%` redirected to the x86 tree, which is
        // what `%ProgramW6432%` exists to undo. `updater.rs` already reads the
        // same three when it decides whether julIDE is an installed copy.
        for pf in program_files_roots() {
            if let Ok(entries) = std::fs::read_dir(&pf) {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let name_str = name.to_string_lossy();
                    if name_str.starts_with("Julia") && entry.path().is_dir() {
                        let bin = entry.path().join("bin\\julia.exe");
                        if bin.exists() {
                            return Some(bin);
                        }
                    }
                }
            }
        }
    }

    // 5. Scan /Applications for Julia*.app (macOS only)
    #[cfg(target_os = "macos")]
    {
        if let Ok(entries) = std::fs::read_dir("/Applications") {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if name_str.starts_with("Julia") && name_str.ends_with(".app") {
                    let bin = entry.path().join("Contents/Resources/julia/bin/julia");
                    if bin.exists() {
                        return Some(bin);
                    }
                }
            }
        }
    }

    None
}

#[tauri::command]
pub async fn julia_get_version() -> Result<String, String> {
    let julia = find_julia()
        .await
        .ok_or_else(|| "Julia not found. Install Julia or set JULIA_PATH.".to_string())?;

    let mut cmd = tokio::process::Command::new(&julia);
    cmd.arg("--version");
    hide_console(&mut cmd);
    let output = cmd.output().await.map_err(|e| e.to_string())?;

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
pub async fn julia_list_environments() -> Result<Vec<String>, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not determine home directory".to_string())?;
    let envs_path = home.join(".julia").join("environments");

    let mut envs = vec!["@v#.#".to_string()];
    if let Ok(entries) = std::fs::read_dir(&envs_path) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                envs.push(entry.file_name().to_string_lossy().to_string());
            }
        }
    }
    Ok(envs)
}

/// Julia code prepended to every `julia_run` invocation.
/// Registers a custom AbstractDisplay that intercepts rich MIME types
/// (images, SVG, HTML) and emits them as `%%JULIDE_MIME%%{...}%%` lines on
/// stdout so the OutputPanel can render them inline.
const MIME_HELPER: &str = r#"
using Base64
ENV["GKSwstype"] = "100"

struct _JulIDEMIMEDisplay_ <: AbstractDisplay end

function Base.display(d::_JulIDEMIMEDisplay_, x)
    for mime in (
        MIME("image/png"),
        MIME("image/svg+xml"),
        MIME("image/jpeg"),
        MIME("text/html"),
    )
        if showable(mime, x)
            io = IOBuffer()
            show(io, mime, x)
            data = base64encode(take!(io))
            println(
                stdout,
                "%%JULIDE_MIME%%{\"type\":\"$(string(mime))\",\"data\":\"$(data)\"}%%"
            )
            flush(stdout)
            return nothing
        end
    end

    # Fall back to plain text
    show(stdout, MIME("text/plain"), x)
    println(stdout)
    flush(stdout)
    return nothing
end

Base.Multimedia.pushdisplay(_JulIDEMIMEDisplay_())
"#;

#[tauri::command]
pub async fn julia_run(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedJuliaState>,
    file_path: String,
    project_path: Option<String>,
) -> Result<(), String> {
    use tauri::Emitter;
    use tokio::io::AsyncBufReadExt;

    validate_path(&file_path, "File path")?;
    if let Some(ref proj) = project_path {
        validate_path(proj, "Project path")?;
    }

    let julia = find_julia()
        .await
        .ok_or_else(|| "Julia not found. Install Julia or set JULIA_PATH.".to_string())?;

    // Build an inline script: MIME helper + include(user_file).
    // Using -e preserves @__FILE__ inside the included file.
    let script = format!("{}\ninclude(ENV[\"JULIDE_FILE_PATH\"])", MIME_HELPER);

    let mut cmd = tokio::process::Command::new(&julia);
    cmd.env("JULIDE_FILE_PATH", &file_path);
    if let Some(ref proj) = project_path {
        cmd.arg(format!("--project={}", proj));
    }
    cmd.arg("-e").arg(&script);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);
    hide_console(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    {
        let mut lock = state.lock().await;
        lock.process_pid = child.id();
    }

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let app_out = app.clone();
    let app_err = app.clone();
    let app_done = app.clone();
    let state_done = state.inner().clone();

    tokio::spawn(async move {
        let reader = tokio::io::BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_out.emit(
                "julia-output",
                JuliaOutputEvent {
                    kind: "stdout".into(),
                    text: normalize_julia_stdio_line(line),
                    exit_code: None,
                },
            );
        }
    });

    tokio::spawn(async move {
        let reader = tokio::io::BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_err.emit(
                "julia-output",
                JuliaOutputEvent {
                    kind: "stderr".into(),
                    text: normalize_julia_stdio_line(line),
                    exit_code: None,
                },
            );
        }
    });

    tokio::spawn(async move {
        let status = child.wait().await;
        let code = status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
        {
            let mut lock = state_done.lock().await;
            lock.process_pid = None;
        }
        let _ = app_done.emit(
            "julia-output",
            JuliaOutputEvent {
                kind: "done".into(),
                text: String::new(),
                exit_code: Some(code),
            },
        );
    });

    Ok(())
}

#[tauri::command]
pub async fn julia_precompile(
    app: tauri::AppHandle,
    project_path: Option<String>,
) -> Result<(), String> {
    use tauri::Emitter;
    use tokio::io::AsyncBufReadExt;

    if let Some(ref proj) = project_path {
        validate_path(proj, "Project path")?;
    }

    let julia = find_julia()
        .await
        .ok_or_else(|| "Julia not found.".to_string())?;

    let mut cmd = tokio::process::Command::new(&julia);
    if let Some(ref proj) = project_path {
        cmd.arg(format!("--project={}", proj));
    } else {
        cmd.arg("--project=@.");
    }
    cmd.arg("-e").arg("using Pkg; Pkg.precompile()");
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    hide_console(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let app_out = app.clone();
    let app_err = app.clone();
    let app_done = app.clone();

    tokio::spawn(async move {
        let reader = tokio::io::BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_out.emit(
                "julia-output",
                JuliaOutputEvent {
                    kind: "stdout".into(),
                    text: normalize_julia_stdio_line(line),
                    exit_code: None,
                },
            );
        }
    });

    tokio::spawn(async move {
        let reader = tokio::io::BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_err.emit(
                "julia-output",
                JuliaOutputEvent {
                    kind: "stderr".into(),
                    text: normalize_julia_stdio_line(line),
                    exit_code: None,
                },
            );
        }
    });

    tokio::spawn(async move {
        let status = child.wait().await;
        let code = status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
        let _ = app_done.emit(
            "julia-output",
            JuliaOutputEvent {
                kind: "done".into(),
                text: String::new(),
                exit_code: Some(code),
            },
        );
    });

    Ok(())
}

#[tauri::command]
pub async fn julia_clean(
    app: tauri::AppHandle,
    project_path: Option<String>,
) -> Result<(), String> {
    use tauri::Emitter;

    let proj = project_path.as_deref().unwrap_or(".");

    let manifest = format!("{}/Manifest.toml", proj);
    let mut cleaned = vec![];

    if std::fs::remove_file(&manifest).is_ok() {
        cleaned.push(manifest.clone());
    }

    // Remove compiled cache under .julia/compiled/
    let msg = if cleaned.is_empty() {
        "Nothing to clean.".to_string()
    } else {
        format!("Removed: {}", cleaned.join(", "))
    };

    let _ = app.emit(
        "julia-output",
        JuliaOutputEvent {
            kind: "stdout".into(),
            text: msg,
            exit_code: None,
        },
    );
    let _ = app.emit(
        "julia-output",
        JuliaOutputEvent {
            kind: "done".into(),
            text: String::new(),
            exit_code: Some(0),
        },
    );

    Ok(())
}

#[tauri::command]
pub async fn julia_kill(state: tauri::State<'_, SharedJuliaState>) -> Result<(), String> {
    let lock = state.lock().await;
    if let Some(pid) = lock.process_pid {
        #[cfg(unix)]
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
        #[cfg(windows)]
        {
            // On Windows use taskkill
            let mut cmd = std::process::Command::new("taskkill");
            cmd.args(["/PID", &pid.to_string(), "/F"]);
            let _ = hide_console_sync(&mut cmd).output();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn julia_pkg_add(
    app: tauri::AppHandle,
    package_name: String,
    project_path: Option<String>,
) -> Result<(), String> {
    use tauri::Emitter;
    use tokio::io::AsyncBufReadExt;

    validate_package_name(&package_name)?;
    if let Some(ref proj) = project_path {
        validate_path(proj, "Project path")?;
    }

    let julia = find_julia()
        .await
        .ok_or_else(|| "Julia not found.".to_string())?;

    let script = r#"using Pkg; Pkg.add(ENV["JULIDE_PKG_NAME"])"#;

    let mut cmd = tokio::process::Command::new(&julia);
    cmd.env("JULIDE_PKG_NAME", &package_name);
    if let Some(ref proj) = project_path {
        cmd.arg(format!("--project={}", proj));
    } else {
        cmd.arg("--project=@.");
    }
    cmd.arg("-e").arg(script);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    hide_console(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let app_out = app.clone();
    let app_err = app.clone();
    let app_done = app.clone();

    tokio::spawn(async move {
        let reader = tokio::io::BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_out.emit(
                "julia-output",
                JuliaOutputEvent {
                    kind: "stdout".into(),
                    text: normalize_julia_stdio_line(line),
                    exit_code: None,
                },
            );
        }
    });

    tokio::spawn(async move {
        let reader = tokio::io::BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_err.emit(
                "julia-output",
                JuliaOutputEvent {
                    kind: "stderr".into(),
                    text: normalize_julia_stdio_line(line),
                    exit_code: None,
                },
            );
        }
    });

    tokio::spawn(async move {
        let status = child.wait().await;
        let code = status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
        let _ = app_done.emit(
            "julia-output",
            JuliaOutputEvent {
                kind: "done".into(),
                text: String::new(),
                exit_code: Some(code),
            },
        );
    });

    Ok(())
}

#[tauri::command]
pub async fn julia_pkg_rm(
    app: tauri::AppHandle,
    package_name: String,
    project_path: Option<String>,
) -> Result<(), String> {
    use tauri::Emitter;
    use tokio::io::AsyncBufReadExt;

    validate_package_name(&package_name)?;
    if let Some(ref proj) = project_path {
        validate_path(proj, "Project path")?;
    }

    let julia = find_julia()
        .await
        .ok_or_else(|| "Julia not found.".to_string())?;

    let script = r#"using Pkg; Pkg.rm(ENV["JULIDE_PKG_NAME"])"#;

    let mut cmd = tokio::process::Command::new(&julia);
    cmd.env("JULIDE_PKG_NAME", &package_name);
    if let Some(ref proj) = project_path {
        cmd.arg(format!("--project={}", proj));
    } else {
        cmd.arg("--project=@.");
    }
    cmd.arg("-e").arg(script);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    hide_console(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let app_out = app.clone();
    let app_err = app.clone();
    let app_done = app.clone();

    tokio::spawn(async move {
        let reader = tokio::io::BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_out.emit(
                "julia-output",
                JuliaOutputEvent {
                    kind: "stdout".into(),
                    text: normalize_julia_stdio_line(line),
                    exit_code: None,
                },
            );
        }
    });

    tokio::spawn(async move {
        let reader = tokio::io::BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_err.emit(
                "julia-output",
                JuliaOutputEvent {
                    kind: "stderr".into(),
                    text: normalize_julia_stdio_line(line),
                    exit_code: None,
                },
            );
        }
    });

    tokio::spawn(async move {
        let status = child.wait().await;
        let code = status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
        let _ = app_done.emit(
            "julia-output",
            JuliaOutputEvent {
                kind: "done".into(),
                text: String::new(),
                exit_code: Some(code),
            },
        );
    });

    Ok(())
}

/// Create a new Julia project using PkgTemplates.jl.
/// Auto-installs PkgTemplates if not already present.
#[tauri::command]
pub async fn julia_create_project(
    app: tauri::AppHandle,
    package_name: String,
    parent_dir: String,
    user_name: String,
) -> Result<(), String> {
    use tauri::Emitter;
    use tokio::io::AsyncBufReadExt;

    validate_package_name(&package_name)?;
    validate_user_string(&user_name, "Username")?;
    validate_path(&parent_dir, "Parent directory")?;

    let julia = find_julia()
        .await
        .ok_or_else(|| "Julia not found. Install Julia or set JULIA_PATH.".to_string())?;

    let script = r#"try; using PkgTemplates; catch; using Pkg; Pkg.add("PkgTemplates"); using PkgTemplates; end; t = Template(; user=ENV["JULIDE_USER"], dir=ENV["JULIDE_DIR"]); t(ENV["JULIDE_NAME"])"#;

    let mut cmd = tokio::process::Command::new(&julia);
    cmd.env("JULIDE_USER", &user_name);
    cmd.env("JULIDE_DIR", parent_dir.replace('\\', "/"));
    cmd.env("JULIDE_NAME", &package_name);
    cmd.arg("-e").arg(script);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);
    hide_console(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let app_out = app.clone();
    let app_err = app.clone();
    let app_done = app.clone();

    tokio::spawn(async move {
        let reader = tokio::io::BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_out.emit(
                "julia-output",
                JuliaOutputEvent {
                    kind: "stdout".into(),
                    text: normalize_julia_stdio_line(line),
                    exit_code: None,
                },
            );
        }
    });

    tokio::spawn(async move {
        let reader = tokio::io::BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_err.emit(
                "julia-output",
                JuliaOutputEvent {
                    kind: "stderr".into(),
                    text: normalize_julia_stdio_line(line),
                    exit_code: None,
                },
            );
        }
    });

    tokio::spawn(async move {
        let status = child.wait().await;
        let code = status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
        let _ = app_done.emit(
            "julia-output",
            JuliaOutputEvent {
                kind: "done".into(),
                text: String::new(),
                exit_code: Some(code),
            },
        );
    });

    Ok(())
}

/// Create a new Julia project using BestieTemplate.jl.
/// Runs non-interactively with a clean environment (no Tauri/Cargo vars)
/// to avoid breaking pixi/CondaPkg.
// The parameter list is the IPC contract with BestieTemplateDialog.tsx — each field
// maps to one form input. Collapsing it into a struct would only move the argument
// count behind a type without simplifying either side.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn julia_create_project_bestie(
    app: tauri::AppHandle,
    parent_dir: String,
    package_name: String,
    package_owner: String,
    authors: String,
    julia_min_version: String,
    license: String,
    strategy_level: u32,
) -> Result<(), String> {
    use tauri::Emitter;
    use tokio::io::AsyncBufReadExt;

    validate_package_name(&package_name)?;
    validate_user_string(&package_owner, "Package owner")?;
    validate_user_string(&authors, "Authors")?;
    validate_path(&parent_dir, "Parent directory")?;
    if !julia_min_version
        .chars()
        .all(|c| c.is_ascii_digit() || c == '.')
    {
        return Err("Julia minimum version must contain only digits and dots".into());
    }
    const ALLOWED_LICENSES: &[&str] = &["MIT", "Apache-2.0", "GPL-3.0", "MPL-2.0"];
    if !ALLOWED_LICENSES.contains(&license.as_str()) {
        return Err(format!("Unknown license: {}", license));
    }

    let julia = find_julia()
        .await
        .ok_or_else(|| "Julia not found. Install Julia or set JULIA_PATH.".to_string())?;

    let script = r#"try; using BestieTemplate; catch; using Pkg; Pkg.add("BestieTemplate"); using BestieTemplate; end
data = Dict(
    "PackageName" => ENV["JULIDE_PKG_NAME"],
    "PackageOwner" => ENV["JULIDE_PKG_OWNER"],
    "Authors" => ENV["JULIDE_AUTHORS"],
    "JuliaMinVersion" => ENV["JULIDE_JULIA_VER"],
    "License" => ENV["JULIDE_LICENSE"],
    "StrategyLevel" => parse(Int, ENV["JULIDE_STRATEGY"]),
)
dst = joinpath(ENV["JULIDE_PARENT_DIR"], ENV["JULIDE_PKG_NAME"] * ".jl")
BestieTemplate.generate(dst, data; defaults=true, quiet=false)"#;

    let mut cmd = tokio::process::Command::new(&julia);
    // Start with a clean environment to avoid Tauri/Cargo vars
    // breaking pixi/CondaPkg.
    cmd.env_clear();

    #[cfg(unix)]
    {
        if let Ok(home) = std::env::var("HOME") {
            cmd.env("HOME", &home);
        }
        cmd.env("TERM", "xterm-256color");
        // Get a clean PATH from the user's login shell
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        if let Ok(output) = std::process::Command::new(&shell)
            .args(["-l", "-c", "echo $PATH"])
            .output()
        {
            if output.status.success() {
                let path_val = String::from_utf8_lossy(&output.stdout).trim().to_string();
                cmd.env("PATH", &path_val);
            }
        }
    }

    #[cfg(windows)]
    {
        // On Windows, forward essential system variables from the parent
        // process.  Without TEMP/TMP Julia and pixi write temp files to
        // C:\WINDOWS which requires admin privileges.
        const WINDOWS_ESSENTIAL_VARS: &[&str] = &[
            "TEMP",
            "TMP",
            "USERPROFILE",
            "HOMEDRIVE",
            "HOMEPATH",
            "HOME",
            "APPDATA",
            "LOCALAPPDATA",
            "PROGRAMDATA",
            "SystemRoot",
            "windir",
            "SystemDrive",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "CommonProgramFiles",
            "CommonProgramFiles(x86)",
            "PATH",
            "COMPUTERNAME",
            "OS",
            "NUMBER_OF_PROCESSORS",
            "PROCESSOR_ARCHITECTURE",
        ];
        for var_name in WINDOWS_ESSENTIAL_VARS {
            if let Ok(val) = std::env::var(var_name) {
                cmd.env(var_name, &val);
            }
        }
    }
    cmd.env("JULIDE_PKG_NAME", &package_name);
    cmd.env("JULIDE_PKG_OWNER", &package_owner);
    cmd.env("JULIDE_AUTHORS", &authors);
    cmd.env("JULIDE_JULIA_VER", &julia_min_version);
    cmd.env("JULIDE_LICENSE", &license);
    cmd.env("JULIDE_STRATEGY", strategy_level.to_string());
    cmd.env("JULIDE_PARENT_DIR", parent_dir.replace('\\', "/"));
    cmd.arg("-e").arg(script);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);
    hide_console(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let app_out = app.clone();
    let app_err = app.clone();
    let app_done = app.clone();

    tokio::spawn(async move {
        let reader = tokio::io::BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_out.emit(
                "julia-output",
                JuliaOutputEvent {
                    kind: "stdout".into(),
                    text: normalize_julia_stdio_line(line),
                    exit_code: None,
                },
            );
        }
    });

    tokio::spawn(async move {
        let reader = tokio::io::BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_err.emit(
                "julia-output",
                JuliaOutputEvent {
                    kind: "stderr".into(),
                    text: normalize_julia_stdio_line(line),
                    exit_code: None,
                },
            );
        }
    });

    tokio::spawn(async move {
        let status = child.wait().await;
        let code = status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
        let _ = app_done.emit(
            "julia-output",
            JuliaOutputEvent {
                kind: "done".into(),
                text: String::new(),
                exit_code: Some(code),
            },
        );
    });

    Ok(())
}

/// Evaluate a code snippet and capture output (for inline code cells).
/// Like julia_run but takes code directly instead of a file path.
#[tauri::command]
pub async fn julia_eval(
    app: tauri::AppHandle,
    state: tauri::State<'_, SharedJuliaState>,
    code: String,
    project_path: Option<String>,
) -> Result<(), String> {
    use tauri::Emitter;
    use tokio::io::AsyncBufReadExt;

    if let Some(ref proj) = project_path {
        validate_path(proj, "Project path")?;
    }

    let julia = find_julia()
        .await
        .ok_or_else(|| "Julia not found. Install Julia or set JULIA_PATH.".to_string())?;

    let script = format!("{}\n{}", MIME_HELPER, code);

    let mut cmd = tokio::process::Command::new(&julia);
    if let Some(ref proj) = project_path {
        cmd.arg(format!("--project={}", proj));
    }
    cmd.arg("-e").arg(&script);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);
    hide_console(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    {
        let mut lock = state.lock().await;
        lock.process_pid = child.id();
    }

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let app_out = app.clone();
    let app_err = app.clone();
    let app_done = app.clone();
    let state_done = state.inner().clone();

    tokio::spawn(async move {
        let reader = tokio::io::BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_out.emit(
                "julia-output",
                JuliaOutputEvent {
                    kind: "stdout".into(),
                    text: normalize_julia_stdio_line(line),
                    exit_code: None,
                },
            );
        }
    });

    tokio::spawn(async move {
        let reader = tokio::io::BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_err.emit(
                "julia-output",
                JuliaOutputEvent {
                    kind: "stderr".into(),
                    text: normalize_julia_stdio_line(line),
                    exit_code: None,
                },
            );
        }
    });

    tokio::spawn(async move {
        let status = child.wait().await;
        let code = status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
        {
            let mut lock = state_done.lock().await;
            lock.process_pid = None;
        }
        let _ = app_done.emit(
            "julia-output",
            JuliaOutputEvent {
                kind: "done".into(),
                text: String::new(),
                exit_code: Some(code),
            },
        );
    });

    Ok(())
}

#[tauri::command]
pub async fn julia_set_path(path: String) -> Result<(), String> {
    if path.is_empty() {
        let mut cached = JULIA_PATH.lock().await;
        *cached = None;
        return Ok(());
    }
    validate_path(&path, "Julia path")?;
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if !p.is_file() {
        return Err(format!("Not a file: {}", path));
    }

    probe_julia_binary(&p).await?;

    let mut cached = JULIA_PATH.lock().await;
    *cached = Some(p);
    Ok(())
}

/// Confirm a candidate binary really is Julia before we adopt it.
///
/// Whatever ends up here is executed by julia_run, julia_eval, lsp_start,
/// debug_start and pty_create, and the command is reachable straight from the
/// webview — so an `exists()` check alone would let a plugin or an injected script
/// silently repoint "Julia" at an arbitrary executable. Requiring the binary to
/// identify itself as Julia turns a silent hijack into a visible error.
async fn probe_julia_binary(path: &Path) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new(path);
    cmd.arg("--version");
    hide_console(&mut cmd);

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Could not run {}: {}", path.display(), e))?;

    if !output.status.success() {
        return Err(format!(
            "{} exited with a non-zero status when asked for --version; it does not look like a Julia binary.",
            path.display()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let version = stdout.trim();
    if !version.to_lowercase().contains("julia") {
        return Err(format!(
            "{} does not report itself as Julia (got: {:?}). Pick the julia executable itself, not a wrapper or shortcut.",
            path.display(),
            version.chars().take(80).collect::<String>()
        ));
    }

    Ok(version.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── program_files_roots_from ───────────────────────────────
    //
    // The Windows install scan used to look in `C:\Program Files` and
    // `C:\Program Files (x86)`, spelled out. Windows is not always installed on
    // C: — `updater.rs` reads the environment for exactly that reason — and a
    // 32-bit process sees `%ProgramFiles%` redirected to the x86 tree, which is
    // what `%ProgramW6432%` undoes.

    #[test]
    fn prefers_the_native_tree_and_keeps_the_rest() {
        assert_eq!(
            program_files_roots_from([
                Some(r"D:\Program Files".into()),
                Some(r"D:\Program Files (x86)".into()),
                Some(r"D:\Program Files (x86)".into()),
            ]),
            vec![
                PathBuf::from(r"D:\Program Files"),
                PathBuf::from(r"D:\Program Files (x86)"),
            ],
            "ProgramW6432 first, and the repeat dropped"
        );
    }

    /// On a 64-bit process `%ProgramW6432%` and `%ProgramFiles%` are the same
    /// directory, and scanning it twice is wasted work on a cold filesystem.
    #[test]
    fn collapses_the_common_64_bit_case() {
        assert_eq!(
            program_files_roots_from([
                Some(r"C:\Program Files".into()),
                Some(r"C:\Program Files".into()),
                Some(r"C:\Program Files (x86)".into()),
            ]),
            vec![
                PathBuf::from(r"C:\Program Files"),
                PathBuf::from(r"C:\Program Files (x86)"),
            ]
        );
    }

    /// An unset or empty variable is not a directory to scan. `read_dir("")`
    /// fails harmlessly, but a root of `""` would also make `join` produce a
    /// relative path resolved against julIDE's working directory.
    #[test]
    fn skips_variables_that_are_absent_or_empty() {
        assert!(program_files_roots_from([None, None, None]).is_empty());
        assert_eq!(
            program_files_roots_from([None, Some(String::new()), Some(r"C:\PF".into())]),
            vec![PathBuf::from(r"C:\PF")]
        );
    }

    // ── validate_package_name ──────────────────────────────────

    #[test]
    fn valid_package_names() {
        assert!(validate_package_name("HTTP").is_ok());
        assert!(validate_package_name("JSON3").is_ok());
        assert!(validate_package_name("My_Package").is_ok());
        assert!(validate_package_name("A").is_ok());
        assert!(validate_package_name("DataFrames").is_ok());
    }

    #[test]
    fn invalid_package_name_empty() {
        assert!(validate_package_name("").is_err());
    }

    #[test]
    fn invalid_package_name_starts_with_digit() {
        assert!(validate_package_name("3DPlots").is_err());
    }

    #[test]
    fn invalid_package_name_injection_attempts() {
        assert!(validate_package_name(r#"pkg"); exit()"#).is_err());
        assert!(validate_package_name("pkg\n; run(`id`)").is_err());
        assert!(validate_package_name("$(run(`id`))").is_err());
        assert!(validate_package_name("a b").is_err());
        assert!(validate_package_name("a;b").is_err());
        assert!(validate_package_name("a\\nb").is_err());
        assert!(validate_package_name("a\"b").is_err());
    }

    // ── validate_path ──────────────────────────────────────────

    #[test]
    fn valid_paths() {
        assert!(validate_path("/home/user/project", "test").is_ok());
        assert!(validate_path("C:/Users/user/project", "test").is_ok());
        assert!(validate_path("/tmp/path with spaces", "test").is_ok());
        assert!(validate_path("/tmp/path\tok", "test").is_ok());
    }

    #[test]
    fn path_with_null_byte() {
        assert!(validate_path("/home/user\0/evil", "test").is_err());
    }

    #[test]
    fn path_with_control_chars() {
        assert!(validate_path("/home/user/\x01evil", "test").is_err());
        assert!(validate_path("/home/\nevil", "test").is_err());
    }

    // ── validate_user_string ───────────────────────────────────

    #[test]
    fn valid_user_strings() {
        assert!(validate_user_string("octocat", "test").is_ok());
        assert!(validate_user_string("First Last <email@example.com>", "test").is_ok());
        assert!(validate_user_string("line1\nline2", "test").is_ok());
    }

    #[test]
    fn user_string_empty() {
        assert!(validate_user_string("", "test").is_err());
    }

    #[test]
    fn user_string_with_null() {
        assert!(validate_user_string("user\0name", "test").is_err());
    }

    #[test]
    fn user_string_with_control_chars() {
        assert!(validate_user_string("user\x01name", "test").is_err());
    }

    // ── normalize_julia_stdio_line ─────────────────────────────

    #[test]
    fn strips_trailing_cr_from_stdio_lines() {
        assert_eq!(normalize_julia_stdio_line("hello\r".into()), "hello");
        assert_eq!(normalize_julia_stdio_line("a\r\r".into()), "a");
        assert_eq!(normalize_julia_stdio_line("no_cr".into()), "no_cr");
    }
}
