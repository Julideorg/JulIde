import { useIdeStore } from "../stores/useIdeStore";

/**
 * Surface uncaught errors and unhandled promise rejections somewhere the user
 * can actually see them.
 *
 * In a shipped Tauri app the devtools console is closed, so `console.error` alone
 * means failures vanish silently — the Run button appears to do nothing, a panel
 * quietly stops updating, and there is no thread to pull on. Routing these into
 * the Output panel at least leaves a trace the user can read and report.
 */
export function installGlobalErrorHandlers(): void {
  const report = (prefix: string, detail: unknown) => {
    const text = formatError(detail);
    console.error(`[julIDE] ${prefix}:`, detail);
    try {
      useIdeStore.getState().appendOutput({ kind: "stderr", text: `${prefix}: ${text}` });
    } catch {
      // The store itself is broken — the console line above is all we can do.
    }
  };

  window.addEventListener("error", (event) => {
    // Resource load failures (<img>, <script>) also fire here but carry no `error`.
    report("Unexpected error", event.error ?? event.message);
  });

  window.addEventListener("unhandledrejection", (event) => {
    report("Unhandled promise rejection", event.reason);
  });
}

function formatError(detail: unknown): string {
  if (detail instanceof Error) {
    return detail.stack ? `${detail.message}\n${detail.stack}` : detail.message;
  }
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}
