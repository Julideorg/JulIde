import { invoke } from "@tauri-apps/api/core";
import { useIdeStore } from "../stores/useIdeStore";
import type { EditorTab } from "../types";
import { isNotebookPath, materializePair, registerFromSource } from "../notebook/pairing";
import { basename } from "../lsp/uri";

/**
 * Read a file from disk and open it as an editor tab.
 *
 * Lifted out of `ModeBar/modes.ts`, where it was module-private, once the markdown
 * preview needed the same thing for relative links. `openFile` in the store dedupes by
 * path, so opening an already-open file just focuses its tab.
 */
export async function openFileAtPath(
  path: string,
  name = basename(path) || path,
  overrides: Partial<EditorTab> = {},
): Promise<void> {
  // A `.ipynb` opens as its paired jupytext script rather than as raw JSON — the
  // script is what you edit, which is jupytext's whole premise. If the conversion
  // fails the file still opens, just as JSON.
  if (isNotebookPath(path)) {
    try {
      const jlPath = await materializePair(path);
      const jlName = jlPath.split("/").pop() ?? jlPath;
      return await openFileAtPath(jlPath, jlName, overrides);
    } catch (e) {
      console.error("Could not open the notebook as a script:", e);
    }
  }

  const content = await invoke<string>("fs_read_file", { path });
  registerFromSource(path, content);
  const tab: EditorTab = {
    id: path,
    path,
    name,
    content,
    isDirty: false,
    language: name.split(".").pop() ?? "plaintext",
    ...overrides,
  };
  useIdeStore.getState().openFile(tab);
}
