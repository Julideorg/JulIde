import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { enableMapSet } from "immer";

enableMapSet();
import type {
  CommandContribution,
  SidebarPanelContribution,
  BottomPanelContribution,
  StatusBarItemContribution,
  ToolbarButtonContribution,
} from "../types/plugin";

interface PluginStore {
  // ─── Commands ───────────────────────────────────────────────────────────────
  commands: Map<string, CommandContribution>;
  registerCommand: (cmd: CommandContribution) => void;
  unregisterCommand: (id: string) => void;

  // ─── Sidebar Panels ─────────────────────────────────────────────────────────
  sidebarPanels: SidebarPanelContribution[];
  registerSidebarPanel: (panel: SidebarPanelContribution) => void;
  unregisterSidebarPanel: (id: string) => void;

  // ─── Bottom Panels ──────────────────────────────────────────────────────────
  bottomPanels: BottomPanelContribution[];
  registerBottomPanel: (panel: BottomPanelContribution) => void;
  unregisterBottomPanel: (id: string) => void;

  // ─── Status Bar Items ───────────────────────────────────────────────────────
  statusBarItems: StatusBarItemContribution[];
  registerStatusBarItem: (item: StatusBarItemContribution) => void;
  unregisterStatusBarItem: (id: string) => void;

  // ─── Toolbar Buttons ────────────────────────────────────────────────────────
  toolbarButtons: ToolbarButtonContribution[];
  registerToolbarButton: (btn: ToolbarButtonContribution) => void;
  unregisterToolbarButton: (id: string) => void;
}

export const usePluginStore = create<PluginStore>()(
  immer((set) => ({
    // ─── Commands ─────────────────────────────────────────────────────────────
    commands: new Map(),
    registerCommand: (cmd) =>
      set((s) => {
        s.commands.set(cmd.id, cmd);
      }),
    unregisterCommand: (id) =>
      set((s) => {
        s.commands.delete(id);
      }),

    // ─── Sidebar Panels ───────────────────────────────────────────────────────
    sidebarPanels: [],
    registerSidebarPanel: (panel) =>
      set((s) => {
        const idx = s.sidebarPanels.findIndex((p) => p.id === panel.id);
        if (idx >= 0) {
          s.sidebarPanels[idx] = panel;
        } else {
          s.sidebarPanels.push(panel);
          s.sidebarPanels.sort((a, b) => a.order - b.order);
        }
      }),
    unregisterSidebarPanel: (id) =>
      set((s) => {
        s.sidebarPanels = s.sidebarPanels.filter((p) => p.id !== id);
      }),

    // ─── Bottom Panels ────────────────────────────────────────────────────────
    bottomPanels: [],
    registerBottomPanel: (panel) =>
      set((s) => {
        const idx = s.bottomPanels.findIndex((p) => p.id === panel.id);
        if (idx >= 0) {
          s.bottomPanels[idx] = panel;
        } else {
          s.bottomPanels.push(panel);
          s.bottomPanels.sort((a, b) => a.order - b.order);
        }
      }),
    unregisterBottomPanel: (id) =>
      set((s) => {
        s.bottomPanels = s.bottomPanels.filter((p) => p.id !== id);
      }),

    // ─── Status Bar Items ─────────────────────────────────────────────────────
    statusBarItems: [],
    registerStatusBarItem: (item) =>
      set((s) => {
        const idx = s.statusBarItems.findIndex((i) => i.id === item.id);
        if (idx >= 0) {
          s.statusBarItems[idx] = item;
        } else {
          s.statusBarItems.push(item);
          s.statusBarItems.sort((a, b) => a.order - b.order);
        }
      }),
    unregisterStatusBarItem: (id) =>
      set((s) => {
        s.statusBarItems = s.statusBarItems.filter((i) => i.id !== id);
      }),

    // ─── Toolbar Buttons ──────────────────────────────────────────────────────
    toolbarButtons: [],
    registerToolbarButton: (btn) =>
      set((s) => {
        const idx = s.toolbarButtons.findIndex((b) => b.id === btn.id);
        if (idx >= 0) {
          s.toolbarButtons[idx] = btn;
        } else {
          s.toolbarButtons.push(btn);
          s.toolbarButtons.sort((a, b) => a.order - b.order);
        }
      }),
    unregisterToolbarButton: (id) =>
      set((s) => {
        s.toolbarButtons = s.toolbarButtons.filter((b) => b.id !== id);
      }),
  })),
);
