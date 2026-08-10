import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useIdeStore } from "../stores/useIdeStore";
import { hashSource, useNotebookStore, type SessionStatus } from "../stores/useNotebookStore";
import { bundleToOutput, releaseAllOutputs } from "./notebookBlobs";

/**
 * Driving the persistent Julia kernel from the frontend.
 *
 * One subscription for the app's lifetime, routing by `exec_id`. The old cell-execution
 * path registered a fresh `julia-output` listener per run and tore it down only on
 * success, so an error leaked it forever and every survivor then also received later
 * runs' output. Correlating by id instead of "whoever happens to be listening" is the
 * structural fix, not a tighter cleanup.
 */

type MimeBundle = Record<string, string>;

type NotebookOutputEvent = {
  session_id: string;
  exec_id: string;
} & (
  | { kind: "stream"; name: "stdout" | "stderr"; text: string }
  | { kind: "display"; data: MimeBundle }
  | { kind: "result"; execution_count: number; data: MimeBundle }
  | { kind: "error"; ename: string; evalue: string; traceback: string[] }
);

interface NotebookStatusEvent {
  session_id: string;
  state: string;
  exec_id?: string;
  message?: string;
  execution_count?: number;
}

interface SessionInfo {
  sessionId: string;
  pid: number;
  version: string;
  projectPath: string | null;
}

/** One kernel per workspace. Rust imposes no policy, so this is the only place it lives. */
export function notebookSessionId(): string {
  const workspace = useIdeStore.getState().workspacePath;
  // The id goes into a protocol header, so it has to survive validate_id in Rust.
  return workspace ? `ws-${hashSource(workspace)}` : "scratch";
}

let listeners: Promise<UnlistenFn[]> | null = null;
let outputSeq = 0;

function statusFor(state: string): SessionStatus | null {
  switch (state) {
    case "starting":
      return "starting";
    case "ready":
      return "ready";
    case "error":
      return "error";
    case "exited":
      return "off";
    default:
      return null;
  }
}

function ensureListeners(): Promise<UnlistenFn[]> {
  listeners ??= Promise.all([
    listen<NotebookOutputEvent>("notebook-output", (event) => {
      const payload = event.payload;
      const store = useNotebookStore.getState();
      const cellId = store.execToCell[payload.exec_id];
      // An empty exec id is pre-handshake diagnostics — precompilation logs, a
      // startup.jl that prints. There is no cell to attach it to.
      if (!cellId) return;

      const id = `${payload.exec_id}-${outputSeq++}`;
      switch (payload.kind) {
        case "stream":
          store.appendOutput(cellId, {
            id,
            kind: "stream",
            name: payload.name,
            text: payload.text,
          });
          break;
        case "display":
          store.appendOutput(cellId, bundleToOutput(id, "display", payload.data));
          break;
        case "result":
          store.appendOutput(
            cellId,
            bundleToOutput(id, "result", payload.data, payload.execution_count),
          );
          break;
        case "error":
          store.appendOutput(cellId, {
            id,
            kind: "error",
            ename: payload.ename,
            evalue: payload.evalue,
            traceback: payload.traceback,
          });
          break;
      }
    }),

    listen<NotebookStatusEvent>("notebook-status", (event) => {
      const { state, exec_id, message, execution_count } = event.payload;
      const store = useNotebookStore.getState();

      const sessionStatus = statusFor(state);
      if (sessionStatus) {
        store.setSession(event.payload.session_id, sessionStatus, message ?? "");
      }
      if (!exec_id) return;

      const cellId = store.execToCell[exec_id];
      if (!cellId) return;

      switch (state) {
        case "queued":
          store.setCellStatus(cellId, "queued");
          break;
        case "busy":
          store.setCellStatus(cellId, "running");
          break;
        case "idle":
          store.setCellStatus(cellId, "ok", execution_count ?? null);
          break;
        case "error":
          store.setCellStatus(cellId, "error", execution_count ?? null);
          break;
        case "abort":
        case "aborted":
          store.setCellStatus(cellId, "aborted");
          break;
      }
    }),
  ]);
  return listeners;
}

/** Start the kernel if it is not already up. Idempotent in Rust too. */
export async function ensureSession(): Promise<string> {
  await ensureListeners();
  const sessionId = notebookSessionId();
  const projectPath = useIdeStore.getState().workspacePath ?? null;
  const store = useNotebookStore.getState();

  if (store.sessionId === sessionId && store.sessionStatus === "ready") return sessionId;

  store.setSession(sessionId, "starting");
  const info = await invoke<SessionInfo>("notebook_session_start", {
    sessionId,
    projectPath,
  });
  useNotebookStore.getState().setJuliaVersion(info.version);
  return sessionId;
}

/** Queue a cell. Rust serializes execution, so this returns as soon as it is enqueued. */
export async function execCell(
  cellId: string,
  code: string,
  path: string,
  line: number,
): Promise<void> {
  const sessionId = await ensureSession();
  const execId = `x${(outputSeq++).toString(36)}${Date.now().toString(36)}`;
  useNotebookStore.getState().beginExec(execId, cellId, hashSource(code));
  await invoke("notebook_session_exec", { sessionId, execId, code, path, line });
}

/**
 * Interrupt the running cell and drop the queue.
 *
 * Resolves to false where the platform cannot interrupt — Windows, where the only
 * available signal maps to SIGTERM inside Julia and would kill the kernel instead. The
 * caller offers a restart rather than a button that quietly does nothing.
 */
export async function interruptSession(): Promise<boolean> {
  return invoke<boolean>("notebook_session_interrupt", { sessionId: notebookSessionId() });
}

export async function restartSession(): Promise<void> {
  const sessionId = notebookSessionId();
  const projectPath = useIdeStore.getState().workspacePath ?? null;
  releaseAllOutputs();
  const store = useNotebookStore.getState();
  store.clearAllOutputs();
  store.setSession(sessionId, "starting");
  const info = await invoke<SessionInfo>("notebook_session_restart", {
    sessionId,
    projectPath,
  });
  useNotebookStore.getState().setJuliaVersion(info.version);
}

/**
 * Stop a kernel and drop its outputs.
 *
 * Takes the id explicitly because the main caller is a workspace-change teardown, and
 * by the time a cleanup function runs the store already holds the *new* workspace —
 * recomputing the id there would stop the wrong session, or none.
 */
export async function stopSession(sessionId = notebookSessionId()): Promise<void> {
  releaseAllOutputs();
  await invoke("notebook_session_stop", { sessionId });
  useNotebookStore.getState().reset();
}
