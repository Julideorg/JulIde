import { invoke } from "@tauri-apps/api/core";
import { useIdeStore } from "../stores/useIdeStore";
import { showUnsavedPrompt, toast } from "../components/ui";

/**
 * Closing a tab, with the unsaved-changes question in front of it.
 *
 * Every user-initiated close goes through here rather than calling the store's
 * `closeTab` directly. That action is unconditional and stays that way — it is also how
 * a tab gets closed for reasons that are nobody's decision to review — so the guard
 * belongs at the point where a *person* asked.
 *
 * This became load-bearing when autosave stopped running unconditionally. Until 0.5.0
 * every buffer was on disk within 800 ms of the last keystroke, so closing a tab could
 * lose at most that; with autosave off, closing an edited tab can lose an afternoon.
 */

/** Write a tab to disk. Returns false if the write failed, having said so. */
export async function saveTab(tabId: string): Promise<boolean> {
  const state = useIdeStore.getState();
  const tab = state.openTabs.find((t) => t.id === tabId);
  if (!tab) return false;

  // `tab.content` tracks every keystroke through updateTabContent, so it is current for
  // any tab. The live editor is preferred anyway for the one being typed in, matching
  // what the file.save command does.
  const content =
    tabId === state.activeTabId ? (state.editorInstance?.getValue() ?? tab.content) : tab.content;

  try {
    await invoke("fs_write_file", { path: tab.path, content });
    useIdeStore.getState().markTabSaved(tabId);
    return true;
  } catch (e) {
    // Loudly, unlike the autosave path: the user asked for this write, and the tab is
    // about to disappear if it succeeded.
    toast.error("Could not save the file", String(e));
    return false;
  }
}

/**
 * Close a tab, asking first if it has unsaved changes.
 *
 * Resolves true if the tab was closed. A failed save counts as a cancel — the tab stays
 * open with the work still in it, rather than being closed on the strength of a write
 * that did not land.
 */
export async function requestCloseTab(tabId: string): Promise<boolean> {
  const tab = useIdeStore.getState().openTabs.find((t) => t.id === tabId);
  if (!tab) return false;

  if (tab.isDirty) {
    const choice = await showUnsavedPrompt(tab.name);
    if (choice === "cancel") return false;
    if (choice === "save" && !(await saveTab(tabId))) return false;
  }

  // Re-checked rather than closed on the strength of the lookup above: awaiting a
  // dialog gives the tab time to have been closed by something else.
  if (!useIdeStore.getState().openTabs.some((t) => t.id === tabId)) return true;
  useIdeStore.getState().closeTab(tabId);
  return true;
}

/**
 * Settle every unsaved tab, for a quit.
 *
 * Resolves false as soon as one prompt is cancelled, and the caller abandons the quit.
 * Sequential rather than concurrent on purpose: three modal dialogs racing each other
 * for the focus trap is not a design, and the reader needs to see the filenames one at
 * a time to answer honestly.
 */
export async function confirmDiscardAllUnsaved(): Promise<boolean> {
  for (const tab of useIdeStore.getState().openTabs.filter((t) => t.isDirty)) {
    const choice = await showUnsavedPrompt(tab.name);
    if (choice === "cancel") return false;
    if (choice === "save" && !(await saveTab(tab.id))) return false;
  }
  return true;
}

/**
 * Answer the backend's close request.
 *
 * `CloseRequested` in src-tauri/src/lib.rs cancels every window close and emits
 * `close-requested` instead; nothing else will close the window, so this must always
 * reach one of its two ends. Returns an unlisten function for the caller's cleanup.
 */
export async function installCloseGuard(): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen("close-requested", () => {
    void confirmDiscardAllUnsaved().then((proceed) => {
      // Declining leaves the window open — the user chose Cancel, and the backend has
      // already prevented the close.
      if (proceed) void invoke("app_confirm_close");
    });
  });
}
