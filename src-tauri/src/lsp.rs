use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::{oneshot, Mutex};

// ── State ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum LspStatus {
    Off,
    Starting,
    Ready,
    Error,
}

#[derive(Clone, Serialize)]
pub struct LspStatusEvent {
    pub status: LspStatus,
    pub message: Option<String>,
    pub backend: Option<String>,
}

struct LspState {
    // Separate Arc so we can write stdin without holding the whole state lock
    stdin: Option<Arc<Mutex<ChildStdin>>>,
    pending: HashMap<u64, oneshot::Sender<Result<Value, String>>>,
    next_id: u64,
    status: LspStatus,
    backend_name: String,
}

impl Default for LspState {
    fn default() -> Self {
        Self {
            stdin: None,
            pending: HashMap::new(),
            next_id: 1,
            status: LspStatus::Off,
            backend_name: String::new(),
        }
    }
}

static LSP_STATE: Lazy<Arc<Mutex<LspState>>> =
    Lazy::new(|| Arc::new(Mutex::new(LspState::default())));

// ── Helpers ───────────────────────────────────────────────────────────────────

fn emit_status(
    app: &tauri::AppHandle,
    status: LspStatus,
    message: Option<String>,
    backend: Option<String>,
) {
    use tauri::Emitter;
    let _ = app.emit(
        "lsp-status",
        LspStatusEvent {
            status,
            message,
            backend,
        },
    );
}

async fn write_lsp_message(stdin_arc: &Arc<Mutex<ChildStdin>>, msg: &Value) -> Result<(), String> {
    let body = serde_json::to_string(msg).map_err(|e| e.to_string())?;
    let frame = format!("Content-Length: {}\r\n\r\n{}", body.len(), body);
    let mut stdin = stdin_arc.lock().await;
    stdin
        .write_all(frame.as_bytes())
        .await
        .map_err(|e| e.to_string())
}

// ── Stdout reader ─────────────────────────────────────────────────────────────

async fn read_lsp_stdout(
    stdout: tokio::process::ChildStdout,
    state: Arc<Mutex<LspState>>,
    app: tauri::AppHandle,
) {
    let mut reader = BufReader::new(stdout);

    loop {
        // 1. Read headers until blank line
        let mut content_length: Option<usize> = None;
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line).await {
                Ok(0) => {
                    // EOF — server exited; fail all pending requests immediately
                    let mut s = state.lock().await;
                    s.status = LspStatus::Error;
                    s.stdin = None;
                    let display_name = backend_display_name(&s.backend_name).to_string();
                    let backend = s.backend_name.clone();
                    for (_, sender) in s.pending.drain() {
                        let _ = sender.send(Err(format!("{} exited", display_name)));
                    }
                    drop(s);
                    emit_status(
                        &app,
                        LspStatus::Error,
                        Some(format!("{} exited unexpectedly", display_name)),
                        Some(backend),
                    );
                    return;
                }
                Err(e) => {
                    let mut s = state.lock().await;
                    s.status = LspStatus::Error;
                    s.stdin = None;
                    let backend = s.backend_name.clone();
                    for (_, sender) in s.pending.drain() {
                        let _ = sender.send(Err(e.to_string()));
                    }
                    drop(s);
                    emit_status(&app, LspStatus::Error, Some(e.to_string()), Some(backend));
                    return;
                }
                Ok(_) => {}
            }
            let trimmed = line.trim_end_matches(['\r', '\n']);
            if trimmed.is_empty() {
                break; // end of headers
            }
            if let Some(rest) = trimmed.strip_prefix("Content-Length: ") {
                content_length = rest.trim().parse().ok();
            }
            // Ignore other headers (Content-Type, etc.)
        }

        let len = match content_length {
            Some(n) if n > 0 => n,
            _ => continue,
        };

        // 2. Read exactly `len` bytes — NEVER use read_line here
        let mut body = vec![0u8; len];
        if let Err(e) = reader.read_exact(&mut body).await {
            let mut s = state.lock().await;
            s.status = LspStatus::Error;
            s.stdin = None;
            let backend = s.backend_name.clone();
            drop(s);
            emit_status(&app, LspStatus::Error, Some(e.to_string()), Some(backend));
            return;
        }

        let msg: Value = match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(_) => continue, // malformed JSON — skip
        };

        dispatch_message(msg, &state, &app).await;
    }
}

async fn dispatch_message(msg: Value, state: &Arc<Mutex<LspState>>, app: &tauri::AppHandle) {
    use tauri::Emitter;

    // Response: has "id" field and no "method" field
    if msg.get("id").is_some() && msg.get("method").is_none() {
        let id = msg["id"].as_u64().unwrap_or(0);
        let result = if msg.get("error").is_some() {
            Err(msg["error"]["message"]
                .as_str()
                .unwrap_or("LSP error")
                .to_string())
        } else {
            Ok(msg.get("result").cloned().unwrap_or(Value::Null))
        };

        let mut s = state.lock().await;

        // Transition to Ready on successful initialize response
        if s.status == LspStatus::Starting {
            if result.is_ok() {
                s.status = LspStatus::Ready;
                let backend = s.backend_name.clone();
                drop(s);
                emit_status(app, LspStatus::Ready, None, Some(backend));
                // Re-lock to remove from pending
                let mut s2 = state.lock().await;
                if let Some(sender) = s2.pending.remove(&id) {
                    let _ = sender.send(result);
                }
            } else {
                if let Some(sender) = s.pending.remove(&id) {
                    let _ = sender.send(result);
                }
            }
        } else {
            if let Some(sender) = s.pending.remove(&id) {
                let _ = sender.send(result);
            }
        }
        return;
    }

    // Notification or server-initiated request → forward to frontend
    let _ = app.emit("lsp-notification", &msg);
}

// ── Commands ──────────────────────────────────────────────────────────────────

fn backend_display_name(backend: &str) -> &str {
    match backend {
        "jetls" => "JETLS.jl",
        _ => "LanguageServer.jl",
    }
}

#[tauri::command]
pub async fn lsp_start(app: tauri::AppHandle, workspace_path: String) -> Result<(), String> {
    // Already running?
    {
        let s = LSP_STATE.lock().await;
        if s.status == LspStatus::Starting || s.status == LspStatus::Ready {
            return Ok(());
        }
    }

    let settings = crate::settings::settings_load();
    let backend = settings.lsp_backend.clone();

    // Build the LSP server command based on the chosen backend
    let mut cmd = if backend == "jetls" {
        // ── JETLS.jl ────────────────────────────────────────────────────
        let home = dirs_next::home_dir().ok_or("Cannot determine home directory")?;
        let jetls_bin = if cfg!(windows) {
            home.join(".julia").join("bin").join("jetls.bat")
        } else {
            home.join(".julia").join("bin").join("jetls")
        };

        if !jetls_bin.exists() {
            return Err(
                "JETLS.jl is not installed. Install with: julia -e 'using Pkg; Pkg.Apps.add(; url=\"https://github.com/aviatesk/JETLS.jl\", rev=\"release\")'"
                    .to_string(),
            );
        }

        let mut c = tokio::process::Command::new(&jetls_bin);
        c.args(["serve", "--stdio"]);
        c
    } else {
        // ── LanguageServer.jl (default) ─────────────────────────────────
        let julia = crate::julia::find_julia()
            .await
            .ok_or("Julia not found. Install Julia or set JULIA_PATH.")?;

        // Probe: check LanguageServer.jl is available
        let mut probe_cmd = tokio::process::Command::new(&julia);
        probe_cmd
            .args([
                "--startup-file=no",
                &format!("--project={}", workspace_path),
                "-e",
                "using LanguageServer; exit(0)",
            ])
            .env(
                "JULIA_LOAD_PATH",
                format!("{}:@v#.#:@stdlib", workspace_path),
            )
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            probe_cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let probe = probe_cmd.status().await.map_err(|e| e.to_string())?;

        if !probe.success() {
            return Err(
                "LanguageServer.jl is not installed. Run: julia -e 'using Pkg; Pkg.add(\"LanguageServer\")'"
                    .to_string(),
            );
        }

        let mut c = tokio::process::Command::new(&julia);
        c.args([
            "--startup-file=no",
            "--history-file=no",
            &format!("--project={}", workspace_path),
            "-e",
            "using LanguageServer; runserver()",
        ])
        .env(
            "JULIA_LOAD_PATH",
            format!("{}:@v#.#:@stdlib", workspace_path),
        );
        c
    };

    // Common spawn configuration
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    // Set status → Starting
    {
        let mut s = LSP_STATE.lock().await;
        s.status = LspStatus::Starting;
        s.pending.clear();
        s.next_id = 1;
        s.stdin = None;
        s.backend_name = backend.clone();
    }
    emit_status(&app, LspStatus::Starting, None, Some(backend.clone()));

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let child_stdin = child.stdin.take().unwrap();
    let child_stdout = child.stdout.take().unwrap();
    let child_stderr = child.stderr.take().unwrap();

    let stdin_arc = Arc::new(Mutex::new(child_stdin));
    {
        let mut s = LSP_STATE.lock().await;
        s.stdin = Some(stdin_arc);
    }

    // Stdout reader task
    let state_clone = LSP_STATE.clone();
    let app_clone = app.clone();
    tokio::spawn(async move {
        read_lsp_stdout(child_stdout, state_clone, app_clone).await;
    });

    // Stderr drain task — forward to Output panel so crashes are visible
    let app_stderr = app.clone();
    let stderr_label = backend_display_name(&backend).to_string();
    tokio::spawn(async move {
        use tauri::Emitter;
        let mut reader = BufReader::new(child_stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_stderr.emit(
                "julia-output",
                crate::julia::JuliaOutputEvent {
                    kind: "stderr".into(),
                    text: format!("[{}] {}", stderr_label, line),
                    exit_code: None,
                },
            );
        }
    });

    // Keep child alive (kill_on_drop handles cleanup when Arc<stdin> drops)
    tokio::spawn(async move {
        let _ = child.wait().await;
    });

    Ok(())
}

#[tauri::command]
pub async fn lsp_stop(app: tauri::AppHandle) -> Result<(), String> {
    let mut s = LSP_STATE.lock().await;
    s.stdin = None; // drop ChildStdin → EOF → server exits
    for (_, sender) in s.pending.drain() {
        let _ = sender.send(Err("LSP server stopped".to_string()));
    }
    s.status = LspStatus::Off;
    s.backend_name.clear();
    drop(s);
    emit_status(&app, LspStatus::Off, None, None);
    Ok(())
}

#[tauri::command]
pub async fn lsp_send_request(method: String, params: Value) -> Result<Value, String> {
    let (id, rx, stdin_arc) = {
        let mut s = LSP_STATE.lock().await;
        if s.stdin.is_none() {
            return Err("LSP server not running".to_string());
        }
        let id = s.next_id;
        s.next_id += 1;
        let (tx, rx) = oneshot::channel();
        s.pending.insert(id, tx);
        let stdin_arc = s.stdin.clone().unwrap();
        (id, rx, stdin_arc)
    };

    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });

    write_lsp_message(&stdin_arc, &msg).await?;

    // Wait up to 30s for a response
    tokio::time::timeout(std::time::Duration::from_secs(30), rx)
        .await
        .map_err(|_| "LSP request timed out".to_string())?
        .map_err(|_| "LSP response channel closed".to_string())?
}

#[tauri::command]
pub async fn lsp_send_notification(method: String, params: Value) -> Result<(), String> {
    let stdin_arc = {
        let s = LSP_STATE.lock().await;
        s.stdin.clone().ok_or("LSP server not running")?
    };

    let msg = json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
    });

    write_lsp_message(&stdin_arc, &msg).await
}

/// Send a JSON-RPC response to a server-initiated request (e.g. workspace/configuration).
/// The `id` must match the `id` from the server's request.
#[tauri::command]
pub async fn lsp_send_response(id: Value, result: Value) -> Result<(), String> {
    let stdin_arc = {
        let s = LSP_STATE.lock().await;
        s.stdin.clone().ok_or("LSP server not running")?
    };

    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    });

    write_lsp_message(&stdin_arc, &msg).await
}
