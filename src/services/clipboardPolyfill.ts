import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

/**
 * Route navigator.clipboard text access through the Tauri clipboard plugin.
 *
 * The webviews Tauri embeds (WebView2 on Windows, WebKitGTK on Linux) reject
 * navigator.clipboard.readText() without a browser-style permission prompt,
 * which silently breaks Monaco's context-menu Paste (issue #22) — Monaco
 * resolves navigator.clipboard dynamically on every call, so overriding the
 * methods here fixes it. Keyboard copy/paste uses native DOM events and is
 * unaffected.
 */
export function installClipboardPolyfill(): void {
  if (!("__TAURI_INTERNALS__" in window)) return; // plain browser (vite dev, storybook)

  const patchedReadText = async (): Promise<string> => {
    try {
      return (await readText()) ?? "";
    } catch {
      return ""; // plugin rejects when the clipboard is empty or not text
    }
  };
  const patchedWriteText = async (text: string): Promise<void> => {
    await writeText(text ?? "");
  };

  try {
    if (navigator.clipboard) {
      Object.defineProperty(navigator.clipboard, "readText", {
        value: patchedReadText,
        configurable: true,
      });
      Object.defineProperty(navigator.clipboard, "writeText", {
        value: patchedWriteText,
        configurable: true,
      });
    } else {
      // navigator.clipboard can be absent entirely in non-secure contexts
      Object.defineProperty(navigator, "clipboard", {
        value: { readText: patchedReadText, writeText: patchedWriteText },
        configurable: true,
      });
    }
  } catch (err) {
    console.warn("Clipboard polyfill install failed:", err);
  }
}
