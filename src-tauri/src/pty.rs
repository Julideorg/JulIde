use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Clone, Serialize, Deserialize)]
pub struct PtyOutputEvent {
    pub session_id: String,
    pub data: String,
}

pub(crate) struct PtySession {
    pub(crate) writer: Box<dyn Write + Send>,
    pub(crate) master: Box<dyn portable_pty::MasterPty + Send>,
    /// Distinguishes this session from a later one reusing the same id, so a
    /// stale reader thread can't prune its replacement (see register_session).
    pub(crate) generation: u64,
}

pub(crate) static PTY_SESSIONS: Lazy<Arc<Mutex<HashMap<String, PtySession>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

static NEXT_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Julia's Base.repl_cmd only wraps shell-mode commands in a shell on
/// non-Windows, so cmd.exe builtins (dir, type, cls, ...) fail with ENOENT.
/// This defines a MORE SPECIFIC method (upstream's is untyped) that routes
/// non-`cd` commands through %COMSPEC% /c, while replicating upstream's
/// `cd` handling (issue #22).
const WINDOWS_REPL_SHELL_PATCH: &str = r#"function Base.repl_cmd(cmd::Base.Cmd, out)
    cmd.exec .= Base.expanduser.(cmd.exec)
    if isempty(cmd.exec)
        throw(ArgumentError("no cmd to execute"))
    elseif cmd.exec[1] == "cd"
        if length(cmd.exec) > 2
            throw(ArgumentError("cd method only takes one argument"))
        elseif length(cmd.exec) == 2
            dir = cmd.exec[2]
            if dir == "-"
                haskey(ENV, "OLDPWD") || error("cd: OLDPWD not set")
                dir = ENV["OLDPWD"]
            end
        else
            dir = homedir()
        end
        try
            ENV["OLDPWD"] = pwd()
        catch ex
            ex isa Base.IOError || rethrow()
            delete!(ENV, "OLDPWD")
        end
        cd(dir)
        println(out, pwd())
    else
        try
            run(ignorestatus(Base.Cmd(vcat([get(ENV, "COMSPEC", "cmd.exe"), "/c"], cmd.exec))))
        catch
            lasterr = Base.current_exceptions()
            lasterr = Base.ExceptionStack([(exception = e[1], backtrace = []) for e in lasterr])
            Base.invokelatest(Base.display_error, lasterr)
        end
    end
    nothing
end"#;

/// Whether a live PTY already exists for this session id. Create commands
/// return Ok(false) in that case so the frontend re-attaches instead of
/// spawning a replacement (which would kill the running process).
pub(crate) fn session_exists(session_id: &str) -> bool {
    PTY_SESSIONS.lock().unwrap().contains_key(session_id)
}

/// Store the session and spawn the reader thread that forwards PTY output to
/// the frontend. When the process exits, the session is pruned (only if the
/// generation still matches, so a close+recreate with the same id is safe)
/// and a `pty-exit` event is emitted.
pub(crate) fn register_session(
    app: &tauri::AppHandle,
    session_id: &str,
    master: Box<dyn portable_pty::MasterPty + Send>,
) -> Result<(), String> {
    use tauri::Emitter;

    let writer = master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = master.try_clone_reader().map_err(|e| e.to_string())?;
    let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);

    {
        let mut sessions = PTY_SESSIONS.lock().unwrap();
        sessions.insert(
            session_id.to_string(),
            PtySession {
                writer,
                master,
                generation,
            },
        );
    }

    let app_clone = app.clone();
    let sid = session_id.to_string();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_clone.emit(
                        "pty-output",
                        PtyOutputEvent {
                            session_id: sid.clone(),
                            data,
                        },
                    );
                }
            }
        }
        {
            let mut sessions = PTY_SESSIONS.lock().unwrap();
            if sessions.get(&sid).map(|s| s.generation) == Some(generation) {
                sessions.remove(&sid);
            }
        }
        let _ = app_clone.emit(
            "pty-exit",
            PtyOutputEvent {
                session_id: sid,
                data: String::new(),
            },
        );
    });

    Ok(())
}

#[tauri::command]
pub async fn pty_create(
    app: tauri::AppHandle,
    session_id: String,
    julia_path: Option<String>,
    project_path: Option<String>,
) -> Result<bool, String> {
    if session_exists(&session_id) {
        return Ok(false);
    }

    let julia = if let Some(p) = julia_path {
        std::path::PathBuf::from(p)
    } else {
        crate::julia::find_julia()
            .await
            .ok_or_else(|| "Julia not found.".to_string())?
    };

    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system
        .openpty(portable_pty::PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = portable_pty::CommandBuilder::new(&julia);
    if let Some(ref proj) = project_path {
        cmd.arg(format!("--project={}", proj));
    }
    if cfg!(windows) {
        cmd.arg("-i"); // stay interactive despite -e
        cmd.arg("--banner=yes"); // -e alone would suppress the banner
        cmd.arg("-e");
        cmd.arg(WINDOWS_REPL_SHELL_PATCH);
    }
    cmd.env("TERM", "xterm-256color");
    #[cfg(unix)]
    {
        if let Ok(home) = std::env::var("HOME") {
            cmd.env("HOME", &home);
        }
        // Pass PATH from shell detection
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        if let Ok(output) = std::process::Command::new(&shell)
            .args(["-l", "-c", "echo $PATH"])
            .output()
        {
            if output.status.success() {
                let path_val = String::from_utf8_lossy(&output.stdout)
                    .trim()
                    .to_string();
                cmd.env("PATH", &path_val);
            }
        }
    }

    let _child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;

    register_session(&app, &session_id, pair.master)?;

    Ok(true)
}

/// Create a PTY running the user's login shell instead of Julia.
/// Used for tasks like BestieTemplate that need a clean environment.
#[tauri::command]
pub async fn pty_create_shell(
    app: tauri::AppHandle,
    session_id: String,
    working_dir: Option<String>,
) -> Result<bool, String> {
    if session_exists(&session_id) {
        return Ok(false);
    }

    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system
        .openpty(portable_pty::PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = if cfg!(windows) {
        // `env -i` and `$SHELL` don't exist on Windows; spawn cmd.exe directly.
        let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        portable_pty::CommandBuilder::new(comspec)
    } else {
        // Use `env -i` to start with a completely clean environment,
        // then launch a login shell which re-sources the user's profile.
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let mut c = portable_pty::CommandBuilder::new("env");
        c.args(["-i", "TERM=xterm-256color"]);
        if let Ok(home) = std::env::var("HOME") {
            c.arg(format!("HOME={}", home));
        }
        c.arg(&shell);
        c.arg("-l");
        c
    };
    cmd.env("TERM", "xterm-256color");
    if let Some(ref dir) = working_dir {
        cmd.cwd(dir);
    }

    let _child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;

    register_session(&app, &session_id, pair.master)?;

    Ok(true)
}

#[tauri::command]
pub fn pty_write(session_id: String, data: String) -> Result<(), String> {
    let mut sessions = PTY_SESSIONS.lock().unwrap();
    if let Some(session) = sessions.get_mut(&session_id) {
        session
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn pty_resize(session_id: String, rows: u16, cols: u16) -> Result<(), String> {
    let sessions = PTY_SESSIONS.lock().unwrap();
    if let Some(session) = sessions.get(&session_id) {
        session
            .master
            .resize(portable_pty::PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn pty_close(session_id: String) -> Result<(), String> {
    let mut sessions = PTY_SESSIONS.lock().unwrap();
    sessions.remove(&session_id);
    Ok(())
}
