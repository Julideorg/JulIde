import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { usePluginStore } from "../stores/usePluginStore";
import { useIdeStore } from "../stores/useIdeStore";
import { assertCommandAllowed, type PluginPermission } from "./pluginPermissions";
import type { PluginContext, Disposable } from "../types/plugin";

/**
 * Create a frozen plugin context object for a plugin.
 * All registrations are tracked so they can be disposed on deactivation.
 *
 * `granted` is the set of permissions the user approved for this plugin. Every path
 * that reaches a Tauri command goes through {@link assertCommandAllowed} — including
 * the convenience wrappers in `workspace`, not just `ipc.invoke`, so a plugin cannot
 * route around the check by preferring the friendlier API.
 */
export function createPluginContext(
  pluginId: string,
  granted: readonly PluginPermission[] = [],
): {
  context: PluginContext;
  disposeAll: () => void;
} {
  const disposables: Disposable[] = [];

  const track = (d: Disposable): Disposable => {
    disposables.push(d);
    return d;
  };

  // Single choke point: nothing in this module calls `invoke` directly.
  const guardedInvoke = async (command: string, args?: Record<string, unknown>) => {
    assertCommandAllowed(pluginId, command, granted);
    return invoke(command, args);
  };

  const context: PluginContext = {
    pluginId,

    commands: {
      register(id: string, label: string, handler: () => void | Promise<void>): Disposable {
        const fullId = `${pluginId}.${id}`;
        usePluginStore.getState().registerCommand({
          id: fullId,
          label,
          category: pluginId,
          execute: handler,
          pluginId,
        });
        return track({ dispose: () => usePluginStore.getState().unregisterCommand(fullId) });
      },
      async execute(id: string): Promise<void> {
        const cmd = usePluginStore.getState().commands.get(id);
        if (cmd) await cmd.execute();
      },
    },

    ui: {
      registerSidebarPanel(opts): Disposable {
        const id = `${pluginId}.${opts.id}`;
        usePluginStore.getState().registerSidebarPanel({
          id,
          label: opts.label,
          icon: opts.icon,
          order: 100, // plugins render after built-in panels
          render: opts.render,
          pluginId,
        });
        return track({ dispose: () => usePluginStore.getState().unregisterSidebarPanel(id) });
      },
      registerBottomPanel(opts): Disposable {
        const id = `${pluginId}.${opts.id}`;
        usePluginStore.getState().registerBottomPanel({
          id,
          label: opts.label,
          order: 100,
          render: opts.render,
          pluginId,
        });
        return track({ dispose: () => usePluginStore.getState().unregisterBottomPanel(id) });
      },
      registerStatusBarItem(opts): Disposable {
        const id = `${pluginId}.${opts.id}`;
        usePluginStore.getState().registerStatusBarItem({
          id,
          text: opts.text,
          alignment: opts.alignment,
          order: 100,
          onClick: opts.onClick,
          pluginId,
        });
        return track({ dispose: () => usePluginStore.getState().unregisterStatusBarItem(id) });
      },
      registerToolbarButton(opts): Disposable {
        const id = `${pluginId}.${opts.id}`;
        usePluginStore.getState().registerToolbarButton({
          id,
          label: opts.label,
          icon: opts.icon,
          order: 100,
          group: "plugin",
          onClick: opts.onClick,
          pluginId,
        });
        return track({ dispose: () => usePluginStore.getState().unregisterToolbarButton(id) });
      },
      showNotification(message: string, type: "info" | "warning" | "error") {
        const kind = type === "error" ? "stderr" : "info";
        useIdeStore.getState().appendOutput({ kind, text: `[${pluginId}] ${message}` });
      },
    },

    workspace: {
      getPath(): string | null {
        return useIdeStore.getState().workspacePath;
      },
      async readFile(path: string): Promise<string> {
        return (await guardedInvoke("fs_read_file", { path })) as string;
      },
      async writeFile(path: string, content: string): Promise<void> {
        await guardedInvoke("fs_write_file", { path, content });
      },
      onDidChangeFiles(callback: (paths: string[]) => void): Disposable {
        let unlisten: (() => void) | null = null;
        listen<{ path: string; kind: string }>("fs-changed", (e) => {
          callback([e.payload.path]);
        }).then((fn) => { unlisten = fn; });
        return track({
          dispose: () => { unlisten?.(); },
        });
      },
    },

    editor: {
      getActiveFilePath(): string | null {
        const s = useIdeStore.getState();
        const tab = s.openTabs.find((t) => t.id === s.activeTabId);
        return tab?.path ?? null;
      },
      getSelectedText(): string | null {
        const editor = useIdeStore.getState().editorInstance;
        if (!editor) return null;
        const selection = editor.getSelection();
        if (!selection) return null;
        return editor.getModel()?.getValueInRange(selection) ?? null;
      },
    },

    ipc: {
      async invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
        return guardedInvoke(command, args);
      },
      listen(event: string, callback: (payload: unknown) => void): Disposable {
        let unlisten: (() => void) | null = null;
        listen(event, (e) => callback(e.payload)).then((fn) => { unlisten = fn; });
        return track({
          dispose: () => { unlisten?.(); },
        });
      },
    },

    log: {
      info(msg: string) {
        useIdeStore.getState().appendOutput({ kind: "info", text: `[${pluginId}] ${msg}` });
      },
      warn(msg: string) {
        useIdeStore.getState().appendOutput({ kind: "info", text: `[${pluginId}] WARN: ${msg}` });
      },
      error(msg: string) {
        useIdeStore.getState().appendOutput({ kind: "stderr", text: `[${pluginId}] ${msg}` });
      },
    },
  };

  // Freeze the context to prevent mutation by plugins
  Object.freeze(context);
  Object.freeze(context.commands);
  Object.freeze(context.ui);
  Object.freeze(context.workspace);
  Object.freeze(context.editor);
  Object.freeze(context.ipc);
  Object.freeze(context.log);

  return {
    context,
    disposeAll: () => {
      for (const d of disposables) {
        try { d.dispose(); } catch { /* ignore */ }
      }
      disposables.length = 0;
    },
  };
}
