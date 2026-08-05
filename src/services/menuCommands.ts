import { listen } from "@tauri-apps/api/event";
import { usePluginStore } from "../stores/usePluginStore";
import { useIdeStore } from "../stores/useIdeStore";

/**
 * Run frontend commands chosen from the native application menu.
 *
 * The menu lives in Rust (`src-tauri/src/menu.rs`) but the command implementations
 * live here, so menu items carry a command id and the backend emits it. Dispatching
 * through the same registry the command palette uses means the menu, the palette,
 * and any keybinding all share one implementation rather than three that drift.
 */
export async function installMenuCommandListener(): Promise<() => void> {
  return listen<string>("menu-command", async (event) => {
    const id = event.payload;
    const command = usePluginStore.getState().commands.get(id);

    if (!command) {
      // Only reachable if menu.rs references an id that was never registered.
      // Surface it rather than letting the menu item look merely unresponsive.
      const message = `Menu command "${id}" is not registered.`;
      console.error(message);
      useIdeStore.getState().appendOutput({ kind: "stderr", text: message });
      return;
    }

    try {
      await command.execute();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Menu command "${id}" failed:`, e);
      useIdeStore.getState().appendOutput({
        kind: "stderr",
        text: `${command.label} failed: ${message}`,
      });
    }
  });
}
