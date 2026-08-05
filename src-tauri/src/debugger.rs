use crate::sync::LockRecover;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Breakpoint {
    pub file: String,
    pub line: u32,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct DebugVariable {
    pub name: String,
    pub value: String,
    pub type_name: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct DebugStoppedEvent {
    pub file: String,
    pub line: u32,
    pub reason: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct DebugOutputEvent {
    pub kind: String, // "stdout" | "stderr" | "info"
    pub text: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct DebugVariablesEvent {
    pub variables: Vec<DebugVariable>,
}

struct DebugSession {
    stdin: Box<dyn Write + Send>,
}

static DEBUG_SESSION: Lazy<Arc<Mutex<Option<DebugSession>>>> =
    Lazy::new(|| Arc::new(Mutex::new(None)));

static BREAKPOINTS: Lazy<Arc<Mutex<Vec<Breakpoint>>>> =
    Lazy::new(|| Arc::new(Mutex::new(Vec::new())));

#[tauri::command]
pub async fn debug_set_breakpoint(file: String, line: u32) -> Result<(), String> {
    let mut bps = BREAKPOINTS.lock_recover();
    if !bps.iter().any(|b| b.file == file && b.line == line) {
        bps.push(Breakpoint { file, line });
    }
    Ok(())
}

#[tauri::command]
pub async fn debug_remove_breakpoint(file: String, line: u32) -> Result<(), String> {
    let mut bps = BREAKPOINTS.lock_recover();
    bps.retain(|b| !(b.file == file && b.line == line));
    Ok(())
}

#[tauri::command]
pub async fn debug_get_breakpoints() -> Result<Vec<Breakpoint>, String> {
    let bps = BREAKPOINTS.lock_recover();
    Ok(bps.clone())
}

/// Start a debug session for `file_path` using Debugger.jl
#[tauri::command]
pub async fn debug_start(
    app: tauri::AppHandle,
    file_path: String,
    project_path: Option<String>,
) -> Result<(), String> {
    use tauri::Emitter;

    let julia = crate::julia::find_julia()
        .await
        .ok_or_else(|| "Julia not found.".to_string())?;

    let bps = BREAKPOINTS.lock_recover().clone();

    // Build a debug script that sets breakpoints and runs the file
    let mut script = String::from("using Debugger\n");
    for bp in &bps {
        script.push_str(&format!(
            "Debugger.breakpoint(\"{}\", {})\n",
            bp.file.replace('\\', "\\\\"),
            bp.line
        ));
    }
    script.push_str(&format!(
        "include(\"{}\")\n",
        file_path.replace('\\', "\\\\")
    ));

    let mut cmd = std::process::Command::new(&julia);
    if let Some(ref proj) = project_path {
        cmd.arg(format!("--project={}", proj));
    }
    cmd.arg("--interactive");
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    // Send the debug script
    stdin
        .write_all(script.as_bytes())
        .map_err(|e| e.to_string())?;

    {
        let mut session = DEBUG_SESSION.lock_recover();
        *session = Some(DebugSession {
            stdin: Box::new(stdin),
        });
    }

    let app_out = app.clone();
    let app_err = app.clone();
    let app_done = app.clone();

    // Stream stdout — parse for debugger prompts
    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            // Detect debugger stopped prompt (e.g. "In function foo at file.jl:10")
            if line.contains(" at ")
                && (line.starts_with("In ") || line.starts_with("About to run"))
            {
                // Parse stopped location
                let _ = app_out.emit(
                    "debug-output",
                    DebugOutputEvent {
                        kind: "info".into(),
                        text: line.clone(),
                    },
                );
                // Also emit stopped event with best-effort parsing
                let _ = app_out.emit(
                    "debug-stopped",
                    DebugStoppedEvent {
                        file: file_path.clone(),
                        line: 0, // simplified
                        reason: line,
                    },
                );
            } else {
                let _ = app_out.emit(
                    "debug-output",
                    DebugOutputEvent {
                        kind: "stdout".into(),
                        text: line,
                    },
                );
            }
        }
    });

    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            let _ = app_err.emit(
                "debug-output",
                DebugOutputEvent {
                    kind: "stderr".into(),
                    text: line,
                },
            );
        }
    });

    std::thread::spawn(move || {
        let _ = child.wait();
        let _ = app_done.emit(
            "debug-output",
            DebugOutputEvent {
                kind: "info".into(),
                text: "Debug session ended.".into(),
            },
        );
        let mut session = DEBUG_SESSION.lock_recover();
        *session = None;
    });

    Ok(())
}

fn send_debug_command(cmd: &str) -> Result<(), String> {
    let mut session = DEBUG_SESSION.lock_recover();
    if let Some(ref mut s) = *session {
        s.stdin
            .write_all(format!("{}\n", cmd).as_bytes())
            .map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("No active debug session.".into())
    }
}

#[tauri::command]
pub async fn debug_continue() -> Result<(), String> {
    send_debug_command("c")
}

#[tauri::command]
pub async fn debug_step_over() -> Result<(), String> {
    send_debug_command("n")
}

#[tauri::command]
pub async fn debug_step_into() -> Result<(), String> {
    send_debug_command("s")
}

#[tauri::command]
pub async fn debug_step_out() -> Result<(), String> {
    send_debug_command("finish")
}

#[tauri::command]
pub async fn debug_stop() -> Result<(), String> {
    let mut session = DEBUG_SESSION.lock_recover();
    *session = None;
    Ok(())
}

#[tauri::command]
pub async fn debug_get_variables(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Emitter;
    // Request variable listing via `varinfo()` in the debug REPL
    send_debug_command("varinfo()")?;
    // Variables will come back through stdout stream
    // For now emit empty — actual parsing happens in stdout handler
    let _ = app.emit("debug-variables", DebugVariablesEvent { variables: vec![] });
    Ok(())
}
