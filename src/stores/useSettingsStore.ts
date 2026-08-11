import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { invoke } from "@tauri-apps/api/core";
import { fontStack } from "../themes/tokens";

export interface Settings {
  fontSize: number;
  fontFamily: string;
  tabSize: number;
  minimapEnabled: boolean;
  wordWrap: string;
  /**
   * Write the file a moment after typing stops.
   *
   * Off by default. Existing installs are unaffected: `settings_save` writes every
   * field, so their `settings.json` already carries `autoSave: true` and keeps it —
   * quietly disabling autosave under someone who has been relying on it would be a way
   * to lose work, not a fix.
   */
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
  /** Target line length Fatou formats to. Ignored by the Julia-hosted backends. */
  fatouLineWidth: number;
  /** Spaces per indent level Fatou formats with. */
  fatouIndentWidth: number;
  /** Format through the language server before an explicit save. */
  formatOnSave: boolean;
  /** Schema version of the persisted file; owned by the Rust migration. */
  settingsVersion: number;
  startMaximized: boolean;
  /** Show text labels under the activity bar icons. */
  activityBarLabels: boolean;
  /** Sidebar width in px — persisted so a resized layout survives a restart. */
  sidebarWidth: number;
  /** Bottom panel height in px. */
  bottomPanelHeight: number;
  /**
   * Render images stored in the open workspace (relative paths in markdown).
   * Off by default; reads bytes off disk under the workspace root, no network.
   */
  allowLocalImages: boolean;
  /**
   * Render `https://` images in markdown. Off by default, and separate from
   * {@link allowLocalImages} because this one tells the image host your IP address
   * and when you opened the file.
   */
  allowRemoteImages: boolean;
  /**
   * Interface zoom, as a webview scale factor. 1.0 is 100%.
   *
   * Scales the whole window — chrome, editor and terminal alike — because the webview
   * applies it, not the stylesheet. Separate from {@link fontSize}, which is the
   * editor's text and nothing else. Stepped through `src/services/zoom.ts`.
   */
  uiZoom: number;
  /**
   * Write julIDE's own interface in plain ASCII, and stop the editor drawing ligatures.
   *
   * Two halves, because they are two different complaints with one cause. The chrome
   * folds its typographic punctuation — `—`, `…`, `·`, `→`, `⌘` — through
   * `src/services/ascii.ts`. The editor drops the `liga`/`calt` font features, which is
   * what makes JetBrains Mono draw `!=` as `≠` and `->` as `→` even though the file on
   * disk is plain ASCII.
   *
   * Off by default, and it never touches content julIDE did not write: buffer text,
   * terminal output, filenames, branch names, Julia's own messages, LaTeX input
   * (`\alpha`→α) and the markdown preview's document body are all left alone.
   */
  asciiOnly: boolean;
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
  fontFamily: fontStack.mono,
  tabSize: 4,
  minimapEnabled: true,
  wordWrap: "off",
  autoSave: false,
  theme: "julide-dark",
  activityBarLabels: true,
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
  lspBackend: "fatou",
  fatouLineWidth: 92,
  fatouIndentWidth: 4,
  formatOnSave: false,
  settingsVersion: 1,
  startMaximized: true,
  sidebarWidth: 240,
  bottomPanelHeight: 220,
  allowLocalImages: false,
  allowRemoteImages: false,
  uiZoom: 1,
  asciiOnly: false,
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
