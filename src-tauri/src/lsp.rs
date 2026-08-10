use lsp_server::{Connection, Message};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
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

/// How messages reach the running language server.
///
/// The JSON-RPC layer above this is backend-agnostic; only the sink differs.
/// LanguageServer.jl and JETLS.jl are Julia programs, so they can only be
/// talked to as child processes over stdio. Fatou is a Rust library linked into
/// this binary, so it runs on a thread here and is talked to over an in-memory
/// channel — no process, no pipes, and none of the spawn failures those bring.
#[derive(Clone)]
enum Transport {
    /// Framed `Content-Length` JSON-RPC over a child process's stdin.
    Stdio(
        // Separate Arc so we can write stdin without holding the whole state lock
        Arc<Mutex<ChildStdin>>,
    ),
    /// Structured messages straight into Fatou's `lsp_server::Connection`.
    InProcess(crossbeam_channel::Sender<Message>),
}

struct LspState {
    transport: Option<Transport>,
    pending: HashMap<u64, oneshot::Sender<Result<Value, String>>>,
    next_id: u64,
    status: LspStatus,
    backend_name: String,
}

impl Default for LspState {
    fn default() -> Self {
        Self {
            transport: None,
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

/// Convert an outgoing JSON-RPC value into an `lsp_server::Message`.
///
/// `Message` is an untagged enum, so letting serde guess would silently pick
/// the wrong variant for an edge case (a response carrying only an error, say).
/// The shape is unambiguous from which fields are present, so decide here and
/// deserialize into the known variant.
fn value_to_message(msg: &Value) -> Result<Message, String> {
    let has_id = msg.get("id").is_some();
    let has_method = msg.get("method").is_some();
    let parsed = match (has_id, has_method) {
        (true, true) => serde_json::from_value(msg.clone()).map(Message::Request),
        (true, false) => serde_json::from_value(msg.clone()).map(Message::Response),
        (false, true) => serde_json::from_value(msg.clone()).map(Message::Notification),
        (false, false) => return Err("JSON-RPC message has neither id nor method".to_string()),
    };
    parsed.map_err(|e| format!("Could not encode LSP message: {e}"))
}

async fn write_lsp_message(transport: &Transport, msg: &Value) -> Result<(), String> {
    match transport {
        Transport::Stdio(stdin_arc) => {
            let body = serde_json::to_string(msg).map_err(|e| e.to_string())?;
            let frame = format!("Content-Length: {}\r\n\r\n{}", body.len(), body);
            let mut stdin = stdin_arc.lock().await;
            stdin
                .write_all(frame.as_bytes())
                .await
                .map_err(|e| e.to_string())
        }
        Transport::InProcess(sender) => {
            // `Connection::memory()` channels are unbounded, so this never
            // blocks the caller even if Fatou is mid-analysis.
            sender
                .send(value_to_message(msg)?)
                .map_err(|_| "Fatou language server is not running".to_string())
        }
    }
}

// ── Stdout reader ─────────────────────────────────────────────────────────────

/// The server's message stream ended: fail everything still waiting on it.
///
/// `reason` is `None` when the stream simply ended, which is also what a
/// deliberate `lsp_stop` looks like from here — dropping the transport is how
/// both backends are asked to quit. Status is only moved to `Error` if we were
/// not already stopped, so a normal shutdown does not light up the status bar.
async fn handle_backend_exit(
    state: &Arc<Mutex<LspState>>,
    app: &tauri::AppHandle,
    reason: Option<String>,
) {
    let mut s = state.lock().await;
    let was_stopped = s.status == LspStatus::Off;
    let display_name = backend_display_name(&s.backend_name).to_string();
    let backend = s.backend_name.clone();
    let message = reason.unwrap_or_else(|| format!("{} exited unexpectedly", display_name));

    s.transport = None;
    for (_, sender) in s.pending.drain() {
        let _ = sender.send(Err(message.clone()));
    }
    if was_stopped {
        return;
    }
    s.status = LspStatus::Error;
    drop(s);

    emit_status(app, LspStatus::Error, Some(message), Some(backend));
}

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
                    handle_backend_exit(&state, &app, None).await;
                    return;
                }
                Err(e) => {
                    handle_backend_exit(&state, &app, Some(e.to_string())).await;
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
            handle_backend_exit(&state, &app, Some(e.to_string())).await;
            return;
        }

        let msg: Value = match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(_) => continue, // malformed JSON — skip
        };

        dispatch_message(msg, &state, &app).await;
    }
}

// ── In-process reader ─────────────────────────────────────────────────────────

/// Pump Fatou's outgoing messages into the same dispatch path stdio uses.
///
/// Two hops, both load-bearing. `crossbeam`'s `recv` blocks, so it cannot run
/// on the async runtime and gets a dedicated thread. That thread hands off to a
/// tokio channel drained by a *single* task, which is what keeps ordering
/// intact — spawning a task per message would let a `publishDiagnostics`
/// overtake the response it was sent after.
fn spawn_inprocess_reader(
    receiver: crossbeam_channel::Receiver<Message>,
    state: Arc<Mutex<LspState>>,
    app: tauri::AppHandle,
) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();

    std::thread::spawn(move || {
        for msg in receiver {
            let Ok(value) = serde_json::to_value(&msg) else {
                continue;
            };
            if tx.send(value).is_err() {
                break;
            }
        }
        // Falling out means Fatou dropped its sender: it has finished shutting
        // down. Dropping `tx` ends the drain task below.
    });

    tokio::spawn(async move {
        while let Some(value) = rx.recv().await {
            dispatch_message(value, &state, &app).await;
        }
        handle_backend_exit(&state, &app, None).await;
    });
}

/// Start Fatou on a thread and return the channel that talks to it.
///
/// Nothing is spawned as a process and nothing is looked up on `PATH`; the
/// server is this binary's own code.
fn start_fatou(app: &tauri::AppHandle, state: Arc<Mutex<LspState>>) -> Result<Transport, String> {
    let (client, server) = Connection::memory();
    let Connection { sender, receiver } = client;

    let panic_app = app.clone();
    std::thread::Builder::new()
        .name("fatou-lsp".into())
        .spawn(move || {
            // Fatou guards its own request handlers, so this catches only a
            // panic in its main loop. Without it such a panic would surface as
            // nothing but a closed channel, i.e. "exited unexpectedly" with no
            // hint why. Unwinding reaches us because the release profile
            // deliberately keeps `panic = "unwind"` (see Cargo.toml).
            let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| fatou::lsp::serve(&server)));
            let detail = match outcome {
                Ok(Ok(())) => return,
                Ok(Err(e)) => format!("Fatou language server stopped: {e}"),
                Err(_) => "Fatou language server panicked".to_string(),
            };
            // The other backends report trouble on stderr, which is drained
            // into the Output panel. In-process there is no stderr, so put the
            // message on the same channel by hand.
            use tauri::Emitter;
            let _ = panic_app.emit(
                "julia-output",
                crate::julia::JuliaOutputEvent {
                    kind: "stderr".into(),
                    text: format!("[Fatou] {detail}"),
                    exit_code: None,
                },
            );
        })
        .map_err(|e| format!("Could not start the Fatou language server thread: {e}"))?;

    spawn_inprocess_reader(receiver, state, app.clone());
    Ok(Transport::InProcess(sender))
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
        "fatou" => "Fatou",
        "jetls" => "JETLS.jl",
        _ => "LanguageServer.jl",
    }
}

/// Build the child-process command for a Julia-hosted backend.
///
/// Runs before any state is touched so a missing install fails cleanly, with
/// the status untouched and an actionable message.
async fn build_child_command(
    backend: &str,
    workspace_path: &str,
) -> Result<tokio::process::Command, String> {
    let mut cmd = if backend == "jetls" {
        // ── JETLS.jl ────────────────────────────────────────────────────
        let home = dirs::home_dir().ok_or("Cannot determine home directory")?;
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
        // ── LanguageServer.jl ───────────────────────────────────────────
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
        .env("JULIA_LOAD_PATH", julia_load_path(workspace_path));
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

    Ok(cmd)
}

/// `JULIA_LOAD_PATH` for a workspace, using the platform's path separator.
///
/// Julia splits this variable on `;` on Windows and `:` everywhere else. It was
/// hard-coded to `:`, which on Windows turned the whole value into one
/// nonsensical entry — right after the drive letter's own colon — so the
/// workspace project silently failed to load.
fn julia_load_path(workspace_path: &str) -> String {
    let separator = if cfg!(windows) { ';' } else { ':' };
    format!("{workspace_path}{separator}@v#.#{separator}@stdlib")
}

/// Spawn a Julia-hosted backend and wire up its stdio.
async fn start_child_backend(
    app: &tauri::AppHandle,
    mut cmd: tokio::process::Command,
    backend: &str,
) -> Result<Transport, String> {
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let child_stdin = child.stdin.take().unwrap();
    let child_stdout = child.stdout.take().unwrap();
    let child_stderr = child.stderr.take().unwrap();

    // Stdout reader task
    let state_clone = LSP_STATE.clone();
    let app_clone = app.clone();
    tokio::spawn(async move {
        read_lsp_stdout(child_stdout, state_clone, app_clone).await;
    });

    // Stderr drain task — forward to Output panel so crashes are visible
    let app_stderr = app.clone();
    let stderr_label = backend_display_name(backend).to_string();
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

    Ok(Transport::Stdio(Arc::new(Mutex::new(child_stdin))))
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

    // Validate before touching any state: a missing Julia install or package
    // should leave the status where it was, not strand it in `Starting`.
    let command = if backend == "fatou" {
        // Fatou is linked in, so there is nothing to find and nothing to probe.
        None
    } else {
        Some(build_child_command(&backend, &workspace_path).await?)
    };

    // Set status → Starting
    {
        let mut s = LSP_STATE.lock().await;
        s.status = LspStatus::Starting;
        s.pending.clear();
        s.next_id = 1;
        s.transport = None;
        s.backend_name = backend.clone();
    }
    emit_status(&app, LspStatus::Starting, None, Some(backend.clone()));

    let started = match command {
        Some(cmd) => start_child_backend(&app, cmd, &backend).await,
        None => start_fatou(&app, LSP_STATE.clone()),
    };

    let transport = match started {
        Ok(transport) => transport,
        Err(e) => {
            // Reset to Off rather than leaving `Starting` behind — the guard at
            // the top of this function would otherwise refuse every retry for
            // the rest of the session.
            let mut s = LSP_STATE.lock().await;
            s.status = LspStatus::Off;
            s.backend_name.clear();
            drop(s);
            emit_status(&app, LspStatus::Error, Some(e.clone()), Some(backend));
            return Err(e);
        }
    };

    LSP_STATE.lock().await.transport = Some(transport);
    Ok(())
}

#[tauri::command]
pub async fn lsp_stop(app: tauri::AppHandle) -> Result<(), String> {
    let mut s = LSP_STATE.lock().await;
    // Dropping the transport is how both kinds of backend are asked to quit:
    // a child process sees EOF on stdin, and Fatou's main loop sees its
    // receiver disconnect and shuts its analysis thread down on the way out.
    // Status goes to Off first so the reader treats the exit as intentional.
    s.status = LspStatus::Off;
    s.transport = None;
    for (_, sender) in s.pending.drain() {
        let _ = sender.send(Err("LSP server stopped".to_string()));
    }
    s.backend_name.clear();
    drop(s);
    emit_status(&app, LspStatus::Off, None, None);
    Ok(())
}

#[tauri::command]
pub async fn lsp_send_request(method: String, params: Value) -> Result<Value, String> {
    let (id, rx, transport) = {
        let mut s = LSP_STATE.lock().await;
        let Some(transport) = s.transport.clone() else {
            return Err("LSP server not running".to_string());
        };
        let id = s.next_id;
        s.next_id += 1;
        let (tx, rx) = oneshot::channel();
        s.pending.insert(id, tx);
        (id, rx, transport)
    };

    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });

    write_lsp_message(&transport, &msg).await?;

    // Wait up to 30s for a response
    tokio::time::timeout(std::time::Duration::from_secs(30), rx)
        .await
        .map_err(|_| "LSP request timed out".to_string())?
        .map_err(|_| "LSP response channel closed".to_string())?
}

#[tauri::command]
pub async fn lsp_send_notification(method: String, params: Value) -> Result<(), String> {
    let transport = {
        let s = LSP_STATE.lock().await;
        s.transport.clone().ok_or("LSP server not running")?
    };

    let msg = json!({
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
    });

    write_lsp_message(&transport, &msg).await
}

/// Send a JSON-RPC response to a server-initiated request (e.g. workspace/configuration).
/// The `id` must match the `id` from the server's request.
#[tauri::command]
pub async fn lsp_send_response(id: Value, result: Value) -> Result<(), String> {
    let transport = {
        let s = LSP_STATE.lock().await;
        s.transport.clone().ok_or("LSP server not running")?
    };

    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    });

    write_lsp_message(&transport, &msg).await
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── value_to_message ───────────────────────────────────────────────────
    //
    // The in-process transport hands Fatou typed messages rather than framed
    // bytes, so every shape the client sends has to survive this conversion.
    // Getting a variant wrong here is invisible until the server ignores a
    // request at runtime.

    #[test]
    fn encodes_a_request() {
        let msg = json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}});
        match value_to_message(&msg).unwrap() {
            Message::Request(r) => {
                assert_eq!(r.method, "initialize");
                assert_eq!(r.id, 1.into());
            }
            other => panic!("expected a request, got {other:?}"),
        }
    }

    #[test]
    fn encodes_a_notification() {
        // No id — must not be mistaken for a request.
        let msg = json!({"jsonrpc": "2.0", "method": "initialized", "params": {}});
        match value_to_message(&msg).unwrap() {
            Message::Notification(n) => assert_eq!(n.method, "initialized"),
            other => panic!("expected a notification, got {other:?}"),
        }
    }

    #[test]
    fn encodes_a_response() {
        // An id but no method — this is how the client answers a
        // server-initiated request such as workspace/configuration.
        let msg = json!({"jsonrpc": "2.0", "id": 7, "result": null});
        match value_to_message(&msg).unwrap() {
            Message::Response(r) => assert_eq!(r.id, 7.into()),
            other => panic!("expected a response, got {other:?}"),
        }
    }

    #[test]
    fn rejects_a_message_that_is_neither() {
        assert!(value_to_message(&json!({"jsonrpc": "2.0"})).is_err());
    }

    // ── Fatou over an in-memory connection ─────────────────────────────────

    /// Drive the real Fatou server through a handshake.
    ///
    /// This is the payoff of linking it in rather than shipping a sidecar:
    /// a genuine end-to-end LSP exchange with no binary to locate, no process
    /// to spawn, and no Julia toolchain anywhere in sight.
    #[test]
    fn fatou_completes_a_handshake_over_an_in_memory_connection() {
        let (client, server) = Connection::memory();
        let handle = std::thread::spawn(move || fatou::lsp::serve(&server));
        // Split exactly as start_fatou does: the sender lives in the transport,
        // the receiver in the reader. They are released separately, and the
        // order matters for a clean shutdown.
        let Connection { sender, receiver } = client;

        sender
            .send(
                value_to_message(&json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": { "capabilities": {}, "processId": null },
                }))
                .unwrap(),
            )
            .unwrap();

        let reply = receiver.recv().unwrap();
        let Message::Response(response) = reply else {
            panic!("expected an initialize response, got {reply:?}");
        };
        let result = response
            .response_result
            .expect("initialize returned an error");
        let capabilities = &result["capabilities"];

        // The features JulIDE's Monaco providers are gated on.
        for capability in [
            "completionProvider",
            "hoverProvider",
            "definitionProvider",
            "referencesProvider",
            "renameProvider",
            "codeActionProvider",
            "documentFormattingProvider",
            "documentRangeFormattingProvider",
            "documentSymbolProvider",
            "semanticTokensProvider",
        ] {
            assert!(
                !capabilities[capability].is_null(),
                "Fatou did not advertise {capability}: {capabilities}"
            );
        }

        // Monaco counts in UTF-16 code units. We deliberately do not offer
        // `general.positionEncodings`, which must leave Fatou on the LSP
        // default; UTF-8 here would misplace every range in a file with
        // non-ASCII text.
        assert_eq!(capabilities["positionEncoding"], "utf-16");

        // Inlay hints are the one provider Fatou does not implement, which is
        // why the providers ask before requesting rather than assuming.
        assert!(capabilities["inlayHintProvider"].is_null());

        // `initialize_finish` blocks until this arrives — the server does not
        // reach its main loop without it. LspClient sends it immediately after
        // the initialize response for exactly this reason.
        sender
            .send(
                value_to_message(&json!({
                    "jsonrpc": "2.0",
                    "method": "initialized",
                    "params": {},
                }))
                .unwrap(),
            )
            .unwrap();

        // Dropping the sender disconnects Fatou's receiver, which is how
        // lsp_stop asks it to quit. The reader keeps its end alive until Fatou
        // drops the other side — tearing both down at once instead makes
        // Fatou's own outgoing sends fail and it exits with a protocol error.
        drop(sender);
        for _ in receiver {}
        handle
            .join()
            .expect("Fatou panicked on shutdown")
            .expect("Fatou returned an error on shutdown");
    }

    /// The document lifecycle the editor actually drives, end to end.
    ///
    /// The `didChange` shape is the part worth pinning down: Fatou advertises
    /// `INCREMENTAL` sync, but MonacoEditor sends a whole-document change with
    /// no range. That is legal — a rangeless change means "replace everything" —
    /// and this proves Fatou applies it rather than ignoring it, which is what
    /// makes the existing editor wiring work unchanged.
    #[test]
    fn fatou_diagnoses_an_open_document_and_tracks_full_text_edits() {
        let (client, server) = Connection::memory();
        let handle = std::thread::spawn(move || fatou::lsp::serve(&server));
        let Connection { sender, receiver } = client;

        let send = |value: Value| sender.send(value_to_message(&value).unwrap()).unwrap();

        send(json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "capabilities": {}, "processId": null },
        }));
        receiver.recv().unwrap();
        send(json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}));

        let uri = "file:///tmp/julide-lsp-test/a.jl";
        // Unterminated argument list — a guaranteed parse error.
        send(json!({
            "jsonrpc": "2.0", "method": "textDocument/didOpen",
            "params": { "textDocument": {
                "uri": uri, "languageId": "julia", "version": 1, "text": "function f(\n",
            }},
        }));

        let diagnostics = |receiver: &crossbeam_channel::Receiver<Message>| -> Vec<Value> {
            // Diagnostics are published asynchronously off the analysis thread,
            // so skip anything else that arrives first.
            let deadline = std::time::Duration::from_secs(30);
            loop {
                let msg = receiver
                    .recv_timeout(deadline)
                    .expect("timed out waiting for diagnostics");
                if let Message::Notification(n) = msg {
                    if n.method == "textDocument/publishDiagnostics" && n.params["uri"] == uri {
                        return n.params["diagnostics"]
                            .as_array()
                            .cloned()
                            .unwrap_or_default();
                    }
                }
            }
        };

        assert!(
            !diagnostics(&receiver).is_empty(),
            "expected a parse error for an unterminated function"
        );

        // The same whole-document change MonacoEditor sends: one entry, no
        // range. If Fatou ignored it the diagnostics would never clear.
        send(json!({
            "jsonrpc": "2.0", "method": "textDocument/didChange",
            "params": {
                "textDocument": { "uri": uri, "version": 2 },
                "contentChanges": [{ "text": "f(x) = x + 1\n" }],
            },
        }));

        assert!(
            diagnostics(&receiver).is_empty(),
            "fixing the source should clear the diagnostics"
        );

        drop(sender);
        for _ in receiver {}
        handle
            .join()
            .expect("Fatou panicked")
            .expect("Fatou errored");
    }

    /// Run one initialize with the given `rootUri` and report what Fatou did.
    fn initialize_with_root_uri(root_uri: &str) -> Result<(), String> {
        let (client, server) = Connection::memory();
        let handle = std::thread::spawn(move || fatou::lsp::serve(&server));
        let Connection { sender, receiver } = client;

        let params = json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "capabilities": {},
                "processId": null,
                "rootUri": root_uri,
                "workspaceFolders": [{ "uri": root_uri, "name": "proj" }],
            },
        });
        let _ = sender.send(value_to_message(&params).unwrap());

        let replied_ok = matches!(
            receiver.recv_timeout(std::time::Duration::from_secs(30)),
            Ok(Message::Response(ref r)) if r.response_result.is_ok()
        );
        if replied_ok {
            let _ = sender.send(
                value_to_message(&json!({
                    "jsonrpc": "2.0", "method": "initialized", "params": {},
                }))
                .unwrap(),
            );
        }

        drop(sender);
        for _ in receiver {}
        match handle.join().expect("Fatou panicked") {
            Ok(()) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    /// Reproduces issue #38 at the exact layer it broke.
    ///
    /// julIDE used to build this URI by pasting the workspace path onto
    /// `file://`. Every URI field in `lsp-types` is parsed strictly, so a
    /// Windows path arrived as a hostname `C` followed by something that is not
    /// a port, and Fatou gave up before answering the handshake. The assertion
    /// is on the index because that is what the bug report contained, and it is
    /// what ties this test to it.
    #[test]
    fn fatou_rejects_the_concatenated_uri_that_broke_issue_38() {
        let err = initialize_with_root_uri("file://C:\\Users\\joaquim\\proj")
            .expect_err("a URI this malformed must not be accepted");
        assert!(
            err.contains("unexpected character at index 9"),
            "expected the error from issue #38, got: {err}"
        );

        // Not a Windows-only failure: a space is not a character a URI may
        // carry literally either, so this broke on Linux and macOS too.
        assert!(initialize_with_root_uri("file:///home/me/My Proj").is_err());
    }

    /// The same paths, converted rather than concatenated (see src/lsp/uri.ts).
    #[test]
    fn fatou_accepts_the_uris_the_client_now_builds() {
        for uri in [
            "file:///c%3A/Users/joaquim/proj",
            "file:///home/me/My%20Proj",
            "file:///home/jo%C3%A3o/proj",
            "file:///tmp/a%2Cb%3Bc%3Dd%21e/f%28g%29",
            "file://srv/share/proj",
        ] {
            assert!(
                initialize_with_root_uri(uri).is_ok(),
                "Fatou refused {uri}, which is what the client now sends"
            );
        }
    }
}
