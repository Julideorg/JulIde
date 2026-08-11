import { useSettingsStore } from "../stores/useSettingsStore";

/**
 * Interface zoom.
 *
 * The webview does the scaling, so everything scales: the activity bar, the tabs, Monaco
 * and the terminal grid alike. This is the same mechanism VS Code's Zoom In uses, and it
 * is why zoom is not implemented in CSS — julIDE's stylesheet is entirely in `px` with no
 * `rem` anywhere, so scaling the root font size would move nothing, and a CSS `zoom` on
 * the layout root would put Monaco's mouse hit-testing at risk for no gain.
 *
 * The terminal needs no help: TerminalPanel already refits the PTY from a ResizeObserver,
 * and zooming changes its box like any other resize.
 */

/**
 * The ladder, in the order the steps are visited.
 *
 * Discrete rather than a percentage delta so the steps are predictable, land on round
 * numbers, and stop at the ends without needing a separate clamp. The range matches the
 * one `Settings::clamped` enforces in Rust.
 */
const STEPS: readonly number[] = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

const MIN_ZOOM = STEPS[0];
const MAX_ZOOM = STEPS[STEPS.length - 1];

export const DEFAULT_ZOOM = 1;

/** Nearest ladder rung to an arbitrary stored value, which may have been hand-edited. */
function nearestStep(zoom: number): number {
  return STEPS.reduce((best, step) =>
    Math.abs(step - zoom) < Math.abs(best - zoom) ? step : best,
  );
}

/**
 * Hand a zoom factor to the webview.
 *
 * The API is imported lazily, and not only to keep it off the startup path: the test
 * preload replaces `@tauri-apps/api/core` with a mock, and `webview.js` imports an
 * internal binding from it that the mock does not carry — so a top-level import here
 * would take every test in this file down with it.
 *
 * Failure is not reported either way. `bun run dev` serves the frontend in a plain
 * browser with no Tauri host behind it, where this rejects on every call, and a zoom
 * that did not take is not worth a toast in the one place a developer would see it.
 */
export async function applyZoom(zoom: number): Promise<void> {
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().setZoom(zoom);
  } catch {
    /* No webview host — see above. */
  }
}

/**
 * Guard against a keypress being counted twice.
 *
 * Both the native menu accelerator and the window keydown handler can reach these on
 * some platforms — the menu is built in src-tauri/src/menu.rs, and a webview keydown
 * listener is still needed because the accelerator alone does not reach the page
 * reliably on Linux and Windows. For Go to Line, which doubles up the same way, firing
 * twice is invisible. For zoom it would be two steps per press, so a repeat of the same
 * direction inside this window is dropped.
 */
const COALESCE_MS = 100;
let lastStep = { direction: 0, at: 0 };

function stepZoom(direction: 1 | -1): void {
  const now = Date.now();
  if (lastStep.direction === direction && now - lastStep.at < COALESCE_MS) return;
  lastStep = { direction, at: now };

  const current = useSettingsStore.getState().settings.uiZoom;
  const index = STEPS.indexOf(nearestStep(current));
  const next = STEPS[Math.min(STEPS.length - 1, Math.max(0, index + direction))];
  if (next === current) return;

  void setZoom(next);
}

/** Set an exact factor: the Settings panel's control, and the restore on startup. */
export async function setZoom(zoom: number): Promise<void> {
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  await applyZoom(clamped);
  await useSettingsStore.getState().updateSettings({ uiZoom: clamped });
}

export function zoomIn(): void {
  stepZoom(1);
}

export function zoomOut(): void {
  stepZoom(-1);
}

export function zoomReset(): void {
  lastStep = { direction: 0, at: 0 };
  void setZoom(DEFAULT_ZOOM);
}

/** Percentage for display, e.g. `125%`. */
export function zoomLabel(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

export const ZOOM_STEPS = STEPS;

/**
 * Whether a keydown is a zoom shortcut, and which way.
 *
 * Matched on `event.code` rather than `event.key`: the key for Ctrl+= is `"="` unshifted
 * and `"+"` shifted, and changes again under a non-US layout, while `Equal` is the
 * physical key in every case. Both the main row and the numpad are accepted, as VS Code
 * does.
 */
export function matchZoomKey(e: KeyboardEvent): "in" | "out" | "reset" | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  switch (e.code) {
    case "Equal":
    case "NumpadAdd":
      return "in";
    case "Minus":
    case "NumpadSubtract":
      return "out";
    case "Digit0":
    case "Numpad0":
      return "reset";
    default:
      return null;
  }
}
