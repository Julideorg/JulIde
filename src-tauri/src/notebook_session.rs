//! A persistent Julia session behind notebook cells.
//!
//! `julia_eval` spawns a fresh process per call, which is right for "run this file" and
//! wrong for a notebook: `x = 1` in one cell has to be visible from the next. This owns
//! one long-lived `julia` per session id, driven over stdin by `notebook_driver.jl`.
//!
//! ## Shape
//!
//! Three threads per session, because the alternatives all block something that must not
//! block:
//!
//!  - a **writer** thread fed by an mpsc, so a `#[tauri::command]` never blocks a tokio
//!    worker on a full stdin pipe while Julia is mid-cell;
//!  - a **reader** thread parsing the driver's JSON lines into typed events;
//!  - a **stderr** thread, which matters only before the handshake — `startup.jl` runs
//!    ahead of `-e`, so anything it prints reaches the real fd 2 before the driver has
//!    rearranged the streams. Everything before `ready` is forwarded as diagnostics and
//!    never parsed.
//!
//! **Rust owns the execution queue**, one cell in flight. That is what makes "Run All"
//! behave: an error drops the rest of the queue with `aborted` (Jupyter's semantics), and
//! an interrupt clears the queue instead of just interrupting cell 4 and starting cell 5.
//!
//! ## Security
//!
//! These commands are deliberately absent from `COMMAND_PERMISSIONS`, like the
//! marketplace ones. `julia_eval` is already arbitrary execution, so the capability class
//! is not new — but the *persistence* is. A plugin reaching this could read every
//! variable the user's cells defined and rewrite `Main` underneath them, which is a
//! confidentiality and integrity escalation rather than a convenience.

use crate::sync::LockRecover;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use tauri::Emitter;

const DRIVER: &str = include_str!("notebook_driver.jl");

/// Coalescing thresholds for `stream` messages.
///
/// One Julia backtrace arrives as ~25 separate chunks, because the driver forwards
/// whatever `readline` hands it. Emitting each as its own IPC message means hundreds of
/// round trips and store writes for a single error.
const STREAM_FLUSH_BYTES: usize = 64 * 1024;
const STREAM_FLUSH_MS: u128 = 16;

/* ── Events ───────────────────────────────────────────────────────────────── */

pub type MimeBundle = std::collections::BTreeMap<String, String>;

/// Snake_case payload fields, matching `JuliaOutputEvent` and `PtyOutputEvent`.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NotebookOutput {
    Stream {
        name: String,
        text: String,
    },
    Display {
        data: MimeBundle,
    },
    Result {
        execution_count: u32,
        data: MimeBundle,
    },
    Error {
        ename: String,
        evalue: String,
        traceback: Vec<String>,
    },
}

#[derive(Clone, Serialize)]
pub struct NotebookOutputEvent {
    pub session_id: String,
    pub exec_id: String,
    #[serde(flatten)]
    pub output: NotebookOutput,
}

#[derive(Clone, Serialize)]
pub struct NotebookStatusEvent {
    pub session_id: String,
    /// `starting` | `ready` | `queued` | `busy` | `idle` | `aborted` | `error` | `exited`
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exec_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_count: Option<u32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookSessionInfo {
    pub session_id: String,
    pub pid: u32,
    pub version: String,
    pub project_path: Option<String>,
}

/* ── Driver messages ──────────────────────────────────────────────────────── */

/// One line of the driver's output. Parsed here rather than forwarded raw, so a
/// malformed line cannot reach the webview and `session_id` is always stamped by us.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum DriverMessage {
    Ready {
        version: String,
        #[allow(dead_code)]
        pid: u32,
    },
    Status {
        exec_id: String,
        state: String,
    },
    Stream {
        exec_id: String,
        name: String,
        text: String,
    },
    Display {
        exec_id: String,
        data: MimeBundle,
    },
    Result {
        exec_id: String,
        execution_count: u32,
        data: MimeBundle,
    },
    Error {
        exec_id: String,
        ename: String,
        evalue: String,
        traceback: Vec<String>,
    },
    Reply {
        exec_id: String,
        status: String,
        execution_count: u32,
    },
}

/* ── Registry ─────────────────────────────────────────────────────────────── */

pub(crate) struct NotebookSession {
    tx: mpsc::Sender<Vec<u8>>,
    pid: u32,
    version: String,
    generation: u64,
    project_path: Option<String>,
    /// The cell currently running, if any.
    in_flight: Option<String>,
    /// (exec_id, code, path, lineno) waiting their turn.
    pending: VecDeque<(String, String, String, u32)>,
}

static NOTEBOOK_SESSIONS: Lazy<Arc<Mutex<HashMap<String, NotebookSession>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Ids go into a space-delimited protocol header, so an unvalidated one is injection.
fn validate_id(id: &str, what: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 {
        return Err(format!("{what} must be 1-64 characters"));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!(
            "{what} may only contain letters, digits, '-' and '_'"
        ));
    }
    Ok(())
}

fn emit_status(app: &tauri::AppHandle, session_id: &str, state: &str, exec_id: Option<String>) {
    let _ = app.emit(
        "notebook-status",
        NotebookStatusEvent {
            session_id: session_id.to_string(),
            state: state.into(),
            exec_id,
            message: None,
            execution_count: None,
        },
    );
}

fn emit_error_status(app: &tauri::AppHandle, session_id: &str, state: &str, message: String) {
    let _ = app.emit(
        "notebook-status",
        NotebookStatusEvent {
            session_id: session_id.to_string(),
            state: state.into(),
            exec_id: None,
            message: Some(message),
            execution_count: None,
        },
    );
}

/// Frame one execution request. Length-prefixed so code containing any sentinel we might
/// have picked is still read exactly.
fn exec_frame(exec_id: &str, code: &str, path: &str, lineno: u32) -> Vec<u8> {
    use base64::Engine;
    let encoded_path = base64::engine::general_purpose::STANDARD.encode(path);
    let mut out = format!(
        "EXEC {} {} {} {}\n",
        exec_id,
        code.len(),
        lineno,
        encoded_path
    )
    .into_bytes();
    out.extend_from_slice(code.as_bytes());
    out.push(b'\n');
    out
}

/// Hand the next queued cell to Julia, if the session is free. Returns the started id.
fn pump_queue(sessions: &mut HashMap<String, NotebookSession>, session_id: &str) -> Option<String> {
    let session = sessions.get_mut(session_id)?;
    if session.in_flight.is_some() {
        return None;
    }
    let (exec_id, code, path, lineno) = session.pending.pop_front()?;
    let frame = exec_frame(&exec_id, &code, &path, lineno);
    if session.tx.send(frame).is_err() {
        return None;
    }
    session.in_flight = Some(exec_id.clone());
    Some(exec_id)
}

/* ── Reader ───────────────────────────────────────────────────────────────── */

/// Buffered `stream` output waiting to be coalesced into one event.
struct StreamBuffer {
    exec_id: String,
    name: String,
    text: String,
    since: std::time::Instant,
}

fn flush_stream(app: &tauri::AppHandle, session_id: &str, buf: &mut Option<StreamBuffer>) {
    if let Some(b) = buf.take() {
        let _ = app.emit(
            "notebook-output",
            NotebookOutputEvent {
                session_id: session_id.to_string(),
                exec_id: b.exec_id,
                output: NotebookOutput::Stream {
                    name: b.name,
                    text: b.text,
                },
            },
        );
    }
}

fn spawn_reader(
    app: tauri::AppHandle,
    session_id: String,
    generation: u64,
    stdout: std::process::ChildStdout,
) {
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut pending_stream: Option<StreamBuffer> = None;
        let mut handshaken = false;

        for line in reader.lines() {
            let Ok(line) = line else { break };
            if line.is_empty() {
                continue;
            }

            let parsed: Result<DriverMessage, _> = serde_json::from_str(&line);
            let Ok(message) = parsed else {
                // Before the handshake this is ordinary noise — precompilation logs, a
                // startup.jl that prints. After it, a line we cannot parse is a bug
                // worth surfacing rather than swallowing.
                if handshaken {
                    let _ = app.emit(
                        "notebook-output",
                        NotebookOutputEvent {
                            session_id: session_id.clone(),
                            exec_id: String::new(),
                            output: NotebookOutput::Stream {
                                name: "stderr".into(),
                                text: format!("{line}\n"),
                            },
                        },
                    );
                }
                continue;
            };

            // Anything that is not more of the same stream ends the current run of it,
            // so ordering is preserved.
            let extends = match (&message, &pending_stream) {
                (DriverMessage::Stream { exec_id, name, .. }, Some(b)) => {
                    b.exec_id == *exec_id && b.name == *name
                }
                _ => false,
            };
            if !extends {
                flush_stream(&app, &session_id, &mut pending_stream);
            }

            match message {
                DriverMessage::Ready { version, .. } => {
                    handshaken = true;
                    let mut sessions = NOTEBOOK_SESSIONS.lock_recover();
                    if let Some(s) = sessions.get_mut(&session_id) {
                        if s.generation == generation {
                            s.version = version;
                        }
                    }
                    drop(sessions);
                    emit_status(&app, &session_id, "ready", None);
                }

                DriverMessage::Status { exec_id, state } => {
                    emit_status(&app, &session_id, &state, Some(exec_id));
                }

                DriverMessage::Stream {
                    exec_id,
                    name,
                    text,
                } => {
                    match &mut pending_stream {
                        Some(b) => b.text.push_str(&text),
                        None => {
                            pending_stream = Some(StreamBuffer {
                                exec_id,
                                name,
                                text,
                                since: std::time::Instant::now(),
                            })
                        }
                    }
                    let ready = pending_stream.as_ref().is_some_and(|b| {
                        b.text.len() >= STREAM_FLUSH_BYTES
                            || b.since.elapsed().as_millis() >= STREAM_FLUSH_MS
                    });
                    if ready {
                        flush_stream(&app, &session_id, &mut pending_stream);
                    }
                }

                DriverMessage::Display { exec_id, data } => {
                    let _ = app.emit(
                        "notebook-output",
                        NotebookOutputEvent {
                            session_id: session_id.clone(),
                            exec_id,
                            output: NotebookOutput::Display { data },
                        },
                    );
                }

                DriverMessage::Result {
                    exec_id,
                    execution_count,
                    data,
                } => {
                    let _ = app.emit(
                        "notebook-output",
                        NotebookOutputEvent {
                            session_id: session_id.clone(),
                            exec_id,
                            output: NotebookOutput::Result {
                                execution_count,
                                data,
                            },
                        },
                    );
                }

                DriverMessage::Error {
                    exec_id,
                    ename,
                    evalue,
                    traceback,
                } => {
                    let _ = app.emit(
                        "notebook-output",
                        NotebookOutputEvent {
                            session_id: session_id.clone(),
                            exec_id,
                            output: NotebookOutput::Error {
                                ename,
                                evalue,
                                traceback,
                            },
                        },
                    );
                }

                DriverMessage::Reply {
                    exec_id,
                    status,
                    execution_count,
                } => {
                    let mut dropped: Vec<String> = Vec::new();
                    {
                        let mut sessions = NOTEBOOK_SESSIONS.lock_recover();
                        if let Some(s) = sessions.get_mut(&session_id) {
                            if s.generation == generation {
                                s.in_flight = None;
                                // Jupyter's semantics: a failing cell cancels the rest of
                                // a Run All rather than carrying on into code that was
                                // written assuming it succeeded.
                                if status != "ok" {
                                    dropped = s.pending.drain(..).map(|(id, ..)| id).collect();
                                }
                            }
                        }
                    }

                    let _ = app.emit(
                        "notebook-status",
                        NotebookStatusEvent {
                            session_id: session_id.clone(),
                            state: if status == "ok" {
                                "idle".into()
                            } else {
                                status
                            },
                            exec_id: Some(exec_id),
                            message: None,
                            execution_count: Some(execution_count),
                        },
                    );

                    for id in dropped {
                        emit_status(&app, &session_id, "aborted", Some(id));
                    }

                    let started = {
                        let mut sessions = NOTEBOOK_SESSIONS.lock_recover();
                        pump_queue(&mut sessions, &session_id)
                    };
                    if let Some(id) = started {
                        emit_status(&app, &session_id, "busy", Some(id));
                    }
                }
            }
        }

        flush_stream(&app, &session_id, &mut pending_stream);

        // Generation-guarded, so a dying reader cannot prune the session that replaced it.
        let mut sessions = NOTEBOOK_SESSIONS.lock_recover();
        if sessions
            .get(&session_id)
            .is_some_and(|s| s.generation == generation)
        {
            sessions.remove(&session_id);
            drop(sessions);
            emit_status(&app, &session_id, "exited", None);
        }
    });
}

/* ── Commands ─────────────────────────────────────────────────────────────── */

#[tauri::command]
pub async fn notebook_session_start(
    app: tauri::AppHandle,
    session_id: String,
    project_path: Option<String>,
) -> Result<NotebookSessionInfo, String> {
    validate_id(&session_id, "Session id")?;
    if let Some(p) = &project_path {
        crate::julia::validate_path(p, "Project path")?;
    }

    {
        let sessions = NOTEBOOK_SESSIONS.lock_recover();
        if let Some(existing) = sessions.get(&session_id) {
            // A stale `--project` is a baffling failure mode, so a changed project is a
            // restart rather than a silent reuse.
            if existing.project_path == project_path {
                return Ok(NotebookSessionInfo {
                    session_id,
                    pid: existing.pid,
                    version: existing.version.clone(),
                    project_path: existing.project_path.clone(),
                });
            }
        }
    }
    stop_session(&session_id);

    let julia = crate::julia::find_julia()
        .await
        .ok_or_else(|| "Julia not found. Install Julia or set JULIA_PATH.".to_string())?;

    emit_status(&app, &session_id, "starting", None);

    let mut cmd = std::process::Command::new(&julia);
    if let Some(p) = &project_path {
        cmd.arg(format!("--project={p}"));
    }
    // No `-i`: it would make Julia try to run a REPL on the stdin we need for commands.
    cmd.arg("-e").arg(DRIVER);
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            // The UI has already been told "starting"; leaving it stuck there is worse
            // than the error itself.
            let message = format!("could not start Julia: {e}");
            emit_error_status(&app, &session_id, "error", message.clone());
            return Err(message);
        }
    };
    let pid = child.id();
    let generation = NEXT_GENERATION.fetch_add(1, Ordering::SeqCst);

    let mut stdin = child.stdin.take().ok_or("Julia stdin was not piped")?;
    let stdout = child.stdout.take().ok_or("Julia stdout was not piped")?;
    let stderr = child.stderr.take().ok_or("Julia stderr was not piped")?;

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        while let Ok(bytes) = rx.recv() {
            if stdin.write_all(&bytes).is_err() || stdin.flush().is_err() {
                break;
            }
        }
    });

    // Reaped so the process does not linger as a zombie after SHUTDOWN.
    std::thread::spawn(move || {
        let _ = child.wait();
    });

    spawn_reader(app.clone(), session_id.clone(), generation, stdout);

    // Pre-handshake diagnostics only: once the driver is up it has rearranged the
    // streams and nothing reaches the real fd 2.
    {
        let app = app.clone();
        let session_id = session_id.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                let _ = app.emit(
                    "notebook-output",
                    NotebookOutputEvent {
                        session_id: session_id.clone(),
                        exec_id: String::new(),
                        output: NotebookOutput::Stream {
                            name: "stderr".into(),
                            text: format!("{line}\n"),
                        },
                    },
                );
            }
        });
    }

    let mut sessions = NOTEBOOK_SESSIONS.lock_recover();
    sessions.insert(
        session_id.clone(),
        NotebookSession {
            tx,
            pid,
            version: String::new(),
            generation,
            project_path: project_path.clone(),
            in_flight: None,
            pending: VecDeque::new(),
        },
    );

    Ok(NotebookSessionInfo {
        session_id,
        pid,
        version: String::new(),
        project_path,
    })
}

#[tauri::command]
pub async fn notebook_session_exec(
    app: tauri::AppHandle,
    session_id: String,
    exec_id: String,
    code: String,
    path: Option<String>,
    line: Option<u32>,
) -> Result<(), String> {
    validate_id(&session_id, "Session id")?;
    validate_id(&exec_id, "Execution id")?;

    let started = {
        let mut sessions = NOTEBOOK_SESSIONS.lock_recover();
        let session = sessions
            .get_mut(&session_id)
            .ok_or("no notebook session is running")?;
        session.pending.push_back((
            exec_id.clone(),
            code,
            path.unwrap_or_else(|| "notebook.jl".into()),
            line.unwrap_or(1),
        ));
        pump_queue(&mut sessions, &session_id)
    };

    match started {
        Some(id) => emit_status(&app, &session_id, "busy", Some(id)),
        None => emit_status(&app, &session_id, "queued", Some(exec_id)),
    }
    Ok(())
}

/// Interrupt the running cell and drop the queue.
///
/// Returns `false` where interrupting is not supported rather than erroring, so the UI
/// can offer "Restart" instead of a button that quietly does nothing.
#[tauri::command]
pub fn notebook_session_interrupt(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<bool, String> {
    validate_id(&session_id, "Session id")?;

    let (pid, dropped) = {
        let mut sessions = NOTEBOOK_SESSIONS.lock_recover();
        let session = sessions
            .get_mut(&session_id)
            .ok_or("no notebook session is running")?;
        let dropped: Vec<String> = session.pending.drain(..).map(|(id, ..)| id).collect();
        (session.pid, dropped)
    };

    for id in dropped {
        emit_status(&app, &session_id, "aborted", Some(id));
    }

    #[cfg(unix)]
    {
        // The driver calls Base.exit_on_sigint(false), so this throws
        // InterruptException into the running cell rather than killing the process.
        unsafe {
            libc::kill(pid as i32, libc::SIGINT);
        }
        Ok(true)
    }
    #[cfg(windows)]
    {
        // GenerateConsoleCtrlEvent needs a shared console, and CTRL_BREAK_EVENT maps to
        // SIGTERM inside Julia's signals-win.c — it would kill the session rather than
        // interrupt it, which is exactly what we are trying to avoid. Restart instead.
        let _ = pid;
        Ok(false)
    }
}

#[tauri::command]
pub async fn notebook_session_restart(
    app: tauri::AppHandle,
    session_id: String,
    project_path: Option<String>,
) -> Result<NotebookSessionInfo, String> {
    validate_id(&session_id, "Session id")?;
    stop_session(&session_id);
    notebook_session_start(app, session_id, project_path).await
}

#[tauri::command]
pub fn notebook_session_stop(session_id: String) -> Result<(), String> {
    validate_id(&session_id, "Session id")?;
    stop_session(&session_id);
    Ok(())
}

#[tauri::command]
pub fn notebook_session_status(session_id: String) -> Result<Option<NotebookSessionInfo>, String> {
    validate_id(&session_id, "Session id")?;
    let sessions = NOTEBOOK_SESSIONS.lock_recover();
    Ok(sessions.get(&session_id).map(|s| NotebookSessionInfo {
        session_id: session_id.clone(),
        pid: s.pid,
        version: s.version.clone(),
        project_path: s.project_path.clone(),
    }))
}

fn stop_session(session_id: &str) {
    let session = {
        let mut sessions = NOTEBOOK_SESSIONS.lock_recover();
        sessions.remove(session_id)
    };
    let Some(session) = session else { return };
    // Ask first, so the kernel can flush; kill only if it does not go.
    let _ = session.tx.send(b"SHUTDOWN\n".to_vec());
    std::thread::sleep(std::time::Duration::from_millis(120));
    kill_pid(session.pid);
}

fn kill_pid(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .output();
    }
}

/// Reap every kernel on app exit.
///
/// `kill_on_drop` does not help: nothing drops the registry at `exit()`, so without this
/// a quit leaves one orphaned `julia` per notebook session.
pub fn kill_all_on_exit() {
    let mut sessions = NOTEBOOK_SESSIONS.lock_recover();
    for (_, session) in sessions.drain() {
        let _ = session.tx.send(b"SHUTDOWN\n".to_vec());
        kill_pid(session.pid);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_constrained_because_they_go_into_a_protocol_header() {
        assert!(validate_id("main-terminal", "id").is_ok());
        assert!(validate_id("cell_1", "id").is_ok());
        for bad in [
            "",
            "has space",
            "new\nline",
            "semi;colon",
            "quote\"",
            &"x".repeat(65),
        ] {
            assert!(validate_id(bad, "id").is_err(), "accepted: {bad:?}");
        }
    }

    #[test]
    fn exec_frame_is_length_prefixed_so_any_payload_survives() {
        // Code containing what looks like a header must not be re-read as one.
        let code = "s = \"EXEC e9 5 1 x\"\n";
        let frame = exec_frame("e1", code, "/tmp/a.jl", 7);
        let text = String::from_utf8(frame).unwrap();
        let header = text.lines().next().unwrap();
        assert!(header.starts_with(&format!("EXEC e1 {} 7 ", code.len())));
        assert!(text.ends_with("\n"));
        assert!(text.contains(code));
    }

    #[test]
    fn exec_frame_counts_bytes_not_characters() {
        // The driver reads `nbytes` bytes; a char count would truncate mid-sequence.
        let code = "θ = 1  # ∇";
        let frame = exec_frame("e1", code, "/tmp/a.jl", 1);
        let header = String::from_utf8_lossy(&frame)
            .lines()
            .next()
            .unwrap()
            .to_string();
        let declared: usize = header.split(' ').nth(2).unwrap().parse().unwrap();
        assert_eq!(declared, code.len());
        assert_ne!(declared, code.chars().count());
    }

    #[test]
    fn driver_messages_parse() {
        let ready: DriverMessage =
            serde_json::from_str(r#"{"kind":"ready","version":"1.12.6","pid":1}"#).unwrap();
        assert!(matches!(ready, DriverMessage::Ready { .. }));

        let reply: DriverMessage = serde_json::from_str(
            r#"{"kind":"reply","exec_id":"e1","status":"abort","execution_count":3}"#,
        )
        .unwrap();
        match reply {
            DriverMessage::Reply { status, .. } => assert_eq!(status, "abort"),
            _ => panic!("wrong variant"),
        }

        let result: DriverMessage = serde_json::from_str(
            r#"{"kind":"result","exec_id":"e1","execution_count":1,"data":{"text/plain":"42"}}"#,
        )
        .unwrap();
        match result {
            DriverMessage::Result { data, .. } => assert_eq!(data["text/plain"], "42"),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn an_unknown_message_kind_is_rejected_rather_than_guessed_at() {
        assert!(serde_json::from_str::<DriverMessage>(r#"{"kind":"nope"}"#).is_err());
        assert!(serde_json::from_str::<DriverMessage>("not json").is_err());
    }

    #[test]
    fn output_events_serialise_flat_with_a_kind_tag() {
        let json = serde_json::to_string(&NotebookOutputEvent {
            session_id: "ws".into(),
            exec_id: "e1".into(),
            output: NotebookOutput::Stream {
                name: "stdout".into(),
                text: "hi\n".into(),
            },
        })
        .unwrap();
        // The frontend discriminates on `kind`, so it has to be a sibling of the rest.
        assert!(json.contains(r#""kind":"stream""#), "got: {json}");
        assert!(json.contains(r#""session_id":"ws""#), "got: {json}");
        assert!(json.contains(r#""text":"hi\n""#), "got: {json}");
    }
}
