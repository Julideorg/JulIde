/**
 * Utility to reset Zustand stores between tests.
 * Only resets data properties — preserves action functions.
 */
import { useIdeStore } from "../stores/useIdeStore";
import { usePluginStore } from "../stores/usePluginStore";
import { useSettingsStore, defaultSettings } from "../stores/useSettingsStore";
import { resetTauriMocks } from "./tauriMock";

/**
 * Reset all stores to their initial state and clear Tauri mocks.
 * Call this in `beforeEach` to ensure test isolation.
 */
export function resetAllStores(): void {
  resetTauriMocks();

  // Reset IDE store (data only — actions are preserved by not using replace)
  useIdeStore.setState({
    workspacePath: null,
    fileTree: null,
    openTabs: [],
    activeTabId: null,
    splitTabId: null,
    splitEditorOpen: false,
    juliaVersion: "Detecting...",
    juliaEnv: "@v#.#",
    availableEnvs: ["@v#.#"],
    isRunning: false,
    output: [],
    problems: [],
    activeBottomPanel: "output",
    bottomPanelHeight: 220,
    sidebarWidth: 240,
    terminalSessions: [],
    activeTerminalId: null,
    breakpoints: [],
    debug: {
      isDebugging: false,
      isPaused: false,
      currentFile: "",
      currentLine: 0,
      variables: [],
      callStack: [],
    },
    lspStatus: "off",
    lspErrorMessage: null,
    lspBackend: "languageserver",
    editorInstance: null,
    activeSidebarView: "files",
    searchResults: [],
    searchQuery: "",
    isSearching: false,
    reviseEnabled: false,
    plutoStatus: "off",
    plutoMessage: null,
    containerState: "none",
    containerMode: false,
    containerId: null,
    containerName: null,
    containerRuntime: null,
    devcontainerDetected: false,
    devcontainerConfig: null,
    containerLogs: [],
    gitIsRepo: false,
    gitBranch: "",
    gitBranches: [],
    gitFiles: [],
    gitRemotes: [],
    gitStashes: [],
    gitAheadBehind: { ahead: 0, behind: 0 },
    gitProvider: null,
    gitIsSyncing: false,
  });

  // Reset plugin store
  usePluginStore.setState({
    commands: new Map(),
    sidebarPanels: [],
    bottomPanels: [],
    statusBarItems: [],
    toolbarButtons: [],
  });

  // Reset settings store.
  //
  // Reuses the store's own defaults rather than duplicating them: the previous
  // hand-maintained copy had silently drifted and was missing five fields, which
  // nothing caught because test files were excluded from type-checking.
  useSettingsStore.setState({
    settings: { ...defaultSettings },
    loaded: false,
    settingsOpen: false,
  });
}
