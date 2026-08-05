import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { invoke } from "@tauri-apps/api/core";

export interface Settings {
  fontSize: number;
  fontFamily: string;
  tabSize: number;
  minimapEnabled: boolean;
  wordWrap: string;
  autoSave: boolean;
  theme: string;
  terminalFontSize: number;
  recentWorkspaces: string[];
  containerRuntime: string;
  containerRemoteHost: string;
  containerAutoDetect: boolean;
  displayForwarding: boolean;
  gpuPassthrough: boolean;
  selinuxLabel: boolean;
  persistJuliaPackages: boolean;
  plutoPort: number;
  juliaPath: string;
  lspBackend: string;
  startMaximized: boolean;
  /** Sidebar width in px — persisted so a resized layout survives a restart. */
  sidebarWidth: number;
  /** Bottom panel height in px. */
  bottomPanelHeight: number;
}

interface SettingsStore {
  settings: Settings;
  loaded: boolean;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  loadSettings: () => Promise<void>;
  updateSettings: (partial: Partial<Settings>) => Promise<void>;
}

const defaultSettings: Settings = {
  fontSize: 14,
  fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Noto Sans Mono', monospace",
  tabSize: 4,
  minimapEnabled: true,
  wordWrap: "off",
  autoSave: true,
  theme: "julide-dark",
  terminalFontSize: 13,
  recentWorkspaces: [],
  containerRuntime: "auto",
  containerRemoteHost: "",
  containerAutoDetect: true,
  displayForwarding: true,
  gpuPassthrough: false,
  selinuxLabel: true,
  persistJuliaPackages: true,
  plutoPort: 3000,
  juliaPath: "",
  lspBackend: "languageserver",
  startMaximized: true,
  sidebarWidth: 240,
  bottomPanelHeight: 220,
};

export const useSettingsStore = create<SettingsStore>()(
  immer((set, get) => ({
    settings: { ...defaultSettings },
    loaded: false,
    settingsOpen: false,
    setSettingsOpen: (open) =>
      set((s) => {
        s.settingsOpen = open;
      }),
    loadSettings: async () => {
      try {
        const settings = await invoke<Settings>("settings_load");
        set((s) => {
          s.settings = { ...defaultSettings, ...settings };
          s.loaded = true;
        });
      } catch (e) {
        console.error("Failed to load settings:", e);
        set((s) => {
          s.loaded = true;
        });
      }
    },
    updateSettings: async (partial) => {
      const current = get().settings;
      const updated = { ...current, ...partial };
      set((s) => {
        Object.assign(s.settings, partial);
      });
      try {
        await invoke("settings_save", { settings: updated });
      } catch (e) {
        console.error("Failed to save settings:", e);
      }
    },
  }))
);
