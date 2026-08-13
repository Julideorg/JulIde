/**
 * What the Problems panel says when it has no diagnostics to show.
 *
 * Every state that was not `ready` used to render one string —
 * "Waiting for the language server" — so a server that had errored, a server
 * that was never asked to start because no folder was open, and a server that
 * genuinely was still starting all read identically. That is the shape the
 * Windows bug report arrived in, and the reporter had no way to narrow it: a
 * release Windows build has no console and writes no log, and the only place
 * the reason appeared was a tooltip on the status-bar chip.
 *
 * Kept as data rather than JSX so the wording and the branching can be tested
 * without a DOM, which is the only kind of component test this codebase has.
 */

export type LspEmptyStateKind = "ready" | "error" | "no-workspace" | "waiting";

export interface LspEmptyState {
  kind: LspEmptyStateKind;
  /** Always julIDE's own words, so ASCII mode may fold it. */
  title: string;
  hint: string;
  /**
   * Whether `hint` is julIDE's text. False when it is the server's own message,
   * which must reach the user exactly as it came — the same rule that keeps
   * Julia's diagnostics, filenames and terminal output out of the ASCII fold.
   */
  hintIsOurs: boolean;
  /** The single command that resolves the emptiness, if there is one. */
  action: { command: string; label: string } | null;
}

/** Backend names as they are written to the user. */
const BACKEND_NAMES: Record<string, string> = {
  fatou: "Fatou",
  languageserver: "LanguageServer.jl",
  jetls: "JETLS.jl",
};

export function lspEmptyState(
  lspStatus: string,
  lspErrorMessage: string | null,
  backend: string,
  hasWorkspace: boolean,
): LspEmptyState {
  const name = BACKEND_NAMES[backend] ?? "the language server";

  if (lspStatus === "ready") {
    return {
      kind: "ready",
      title: "No problems found",
      hint: `Errors and warnings from ${name} appear here as you type.`,
      hintIsOurs: true,
      action: null,
    };
  }

  if (lspStatus === "error") {
    return {
      kind: "error",
      title: "The language server stopped",
      hint: lspErrorMessage ?? `${name} did not start.`,
      hintIsOurs: lspErrorMessage === null,
      action: { command: "lsp.restart", label: "Restart language server" },
    };
  }

  // `off` with nothing open is not a failure and never resolves on its own:
  // App.tsx starts the server for a workspace, so without one there is nothing
  // to wait for. Saying "waiting" here is how a first run on a clean install
  // looked like a broken language server.
  if (!hasWorkspace) {
    return {
      kind: "no-workspace",
      title: "No folder open",
      hint: "julIDE starts the language server for the folder you open, and diagnostics begin there.",
      hintIsOurs: true,
      action: { command: "file.open-folder", label: "Open Folder" },
    };
  }

  return {
    kind: "waiting",
    title: "Waiting for the language server",
    hint: `Diagnostics appear once ${name} has finished starting.`,
    hintIsOurs: true,
    action: null,
  };
}
