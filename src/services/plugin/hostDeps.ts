/**
 * Binds the dispatcher's injected dependencies to julIDE's real stores.
 *
 * Kept apart from `dispatcher.ts` so the gating logic stays pure and testable. This
 * file is the only place the sandbox touches Zustand, Monaco or `invoke`, and it holds
 * no decisions of its own — every check has already happened by the time anything here
 * is called.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { usePluginStore } from "../../stores/usePluginStore";
import { useIdeStore } from "../../stores/useIdeStore";
import { toast } from "../../components/ui/Toast";
import type { DispatcherDeps } from "./dispatcher";

export interface HostDepsOptions {
  pluginId: string;
  /** Runs one of the plugin's own commands, by asking its frame. */
  executeInFrame: (commandId: string) => Promise<void>;
}

export function createHostDeps(opts: HostDepsOptions): Omit<DispatcherDeps, "emitToFrame"> {
  const { pluginId, executeInFrame } = opts;
  const ide = () => useIdeStore.getState();
  const plugins = () => usePluginStore.getState();

  return {
    invoke: (command, args) => invoke(command, args),

    listen: async (event, cb) => {
      const unlisten = await listen(event, (e) => cb(e.payload));
      return unlisten;
    },

    getWorkspacePath: () => ide().workspacePath,

    getActiveFilePath: () => {
      const s = ide();
      return s.openTabs.find((t) => t.id === s.activeTabId)?.path ?? null;
    },

    getSelectedText: () => {
      const editor = ide().editorInstance;
      const selection = editor?.getSelection();
      if (!editor || !selection) return null;
      return editor.getModel()?.getValueInRange(selection) ?? null;
    },

    registerCommand: (id, label) => {
      plugins().registerCommand({
        id,
        label,
        category: pluginId,
        pluginId,
        // The handler lives in the frame. Running it means asking the frame to, and
        // surfacing a failure here rather than letting it vanish across the boundary.
        execute: async () => {
          try {
            await executeInFrame(id);
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            ide().appendOutput({ kind: "stderr", text: `[${pluginId}] ${id}: ${message}` });
          }
        },
      });
    },

    unregisterCommand: (id) => plugins().unregisterCommand(id),

    executeCommand: async (id) => {
      await plugins().commands.get(id)?.execute();
    },

    commandOwner: (id) => plugins().commands.get(id)?.pluginId,

    setStatusBarItem: (item) => {
      plugins().registerStatusBarItem({
        id: item.id,
        text: item.text,
        tooltip: item.tooltip,
        alignment: item.alignment,
        order: 100,
        pluginId,
        onClick: () => void executeInFrame(`${item.id}:click`),
      });
    },

    removeStatusBarItem: (id) => plugins().unregisterStatusBarItem(id),

    setToolbarButton: (b) => {
      plugins().registerToolbarButton({
        id: b.id,
        label: b.label,
        icon: b.icon,
        order: 100,
        group: "plugin",
        pluginId,
        disabled: () => !b.enabled,
        visible: () => b.visible,
        onClick: () => void executeInFrame(`${b.id}:click`),
      });
    },

    removeToolbarButton: (id) => plugins().unregisterToolbarButton(id),

    setViewTitle: () => {
      // Wired when view frames land; a background frame can never reach this.
    },
    setViewBadge: () => {},

    showNotification: (message, type) => {
      toast[type](pluginId, message);
      ide().appendOutput({
        kind: type === "error" ? "stderr" : "info",
        text: `[${pluginId}] ${message}`,
      });
    },

    log: (level, message) => {
      ide().appendOutput({
        kind: level === "error" ? "stderr" : "info",
        text: level === "warn" ? `[${pluginId}] WARN: ${message}` : `[${pluginId}] ${message}`,
      });
    },
  };
}
