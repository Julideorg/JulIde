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
  /** Non-empty when the last save failed, so the UI can say so. */
  saveError: string;
  setSettingsOpen: (open: boolean) => void;
  loadSettings: () => Promise<void>;
  updateSettings: (partial: Partial<Settings>) => Promise<void>;
  /** Write pending changes immediately instead of waiting for the debounce. */
  flushSettings: () => Promise<void>;
  resetSettings: () => Promise<void>;
}

export const defaultSettings: Settings = {
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

/**
 * Settings are written to disk on a short debounce.
 *
 * The panel calls updateSettings on every keystroke, so an un-debounced save meant
 * roughly twenty disk writes and IPC round-trips to type a font name. The in-memory
 * state still updates immediately — only the persistence is deferred.
 */
const SAVE_DEBOUNCE_MS = 300;

export const useSettingsStore = create<SettingsStore>()(
  immer((set, get) => {
    let saveTimer: ReturnType<typeof setTimeout> | null = null;

    const persist = async () => {
      saveTimer = null;
      try {
        await invoke("settings_save", { settings: get().settings });
        if (get().saveError) {
          set((s) => {
            s.saveError = "";
          });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("Failed to save settings:", e);
        // Previously swallowed: a read-only config dir silently discarded every
        // preference the user set, with no indication anything was wrong.
        set((s) => {
          s.saveError = message;
        });
      }
    };

    return {
      settings: { ...defaultSettings },
      loaded: false,
      settingsOpen: false,
      saveError: "",
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
        set((s) => {
          Object.assign(s.settings, partial);
        });
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => void persist(), SAVE_DEBOUNCE_MS);
      },

      flushSettings: async () => {
        if (saveTimer) {
          clearTimeout(saveTimer);
          saveTimer = null;
        }
        await persist();
      },

      resetSettings: async () => {
        set((s) => {
          // recentWorkspaces is history, not a preference — resetting preferences
          // should not also erase the list of projects you have opened.
          const recents = s.settings.recentWorkspaces;
          s.settings = { ...defaultSettings, recentWorkspaces: recents };
        });
        await get().flushSettings();
      },
    };
  }),
);
