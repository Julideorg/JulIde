import { invoke } from "@tauri-apps/api/core";
import { useIdeStore } from "../stores/useIdeStore";
import type { EditorTab } from "../types";

/**
 * Read a file from disk and open it as an editor tab.
 *
 * Lifted out of `ModeBar/modes.ts`, where it was module-private, once the markdown
 * preview needed the same thing for relative links. `openFile` in the store dedupes by
 * path, so opening an already-open file just focuses its tab.
 */
export async function openFileAtPath(
  path: string,
  name = path.split("/").pop() ?? path,
  overrides: Partial<EditorTab> = {},
): Promise<void> {
  const content = await invoke<string>("fs_read_file", { path });
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
