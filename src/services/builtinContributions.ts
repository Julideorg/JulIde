import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { usePluginStore } from "../stores/usePluginStore";
import { useIdeStore } from "../stores/useIdeStore";
import { useSettingsStore } from "../stores/useSettingsStore";
import { useJuliaStore } from "../stores/useJuliaStore";
import { startDevcontainer } from "./devcontainer";
import { showInputDialog } from "../components/InputDialog/InputDialog";
import { showBestieTemplateDialog } from "../components/BestieTemplateDialog/BestieTemplateDialog";
import { useModeBarStore } from "../components/ModeBar/ModeBar";
import type { FileNode, JuliaOutputEvent, Problem } from "../types";

// Lazy component imports — these are imported by the consumers (App.tsx) already,
// but we reference them here to register sidebar/bottom panels.
// We use dynamic imports to avoid circular dependency issues.

const _componentCache: Record<string, React.ComponentType> = {};

async function getComponent(name: string): Promise<React.ComponentType> {
  if (_componentCache[name]) return _componentCache[name];

  switch (name) {
    case "FileExplorer": {
      const m = await import("../components/FileExplorer/FileExplorer");
      _componentCache[name] = m.FileExplorer;
      return m.FileExplorer;
    }
    case "SearchPanel": {
      const m = await import("../components/SearchPanel/SearchPanel");
      _componentCache[name] = m.SearchPanel;
      return m.SearchPanel;
    }
    case "GitPanel": {
      const m = await import("../components/Git/GitPanel");
      _componentCache[name] = m.GitPanel;
      return m.GitPanel;
    }
    case "ContainerPanel": {
      const m = await import("../components/Container/ContainerPanel");
      _componentCache[name] = m.ContainerPanel;
      return m.ContainerPanel;
    }
    case "OutputPanel": {
      const m = await import("../components/OutputPanel/OutputPanel");
      _componentCache[name] = m.OutputPanel;
      return m.OutputPanel;
    }
    case "TerminalPanel": {
      const m = await import("../components/Terminal/TerminalPanel");
      _componentCache[name] = m.TerminalPanel;
      return m.TerminalPanel;
    }
    case "DebugPanel": {
      const m = await import("../components/Debugger/DebugPanel");
      _componentCache[name] = m.DebugPanel;
      return m.DebugPanel;
    }
    case "PackageManager": {
      const m = await import("../components/PackageManager/PackageManager");
      _componentCache[name] = m.PackageManager;
      return m.PackageManager;
    }
    case "ContainerLogsPanel": {
      const m = await import("../components/Container/ContainerLogsPanel");
      _componentCache[name] = m.ContainerLogsPanel;
      return m.ContainerLogsPanel;
    }
    case "OutlinePanel": {
      const m = await import("../components/Outline/OutlinePanel");
      _componentCache[name] = m.OutlinePanel;
      return m.OutlinePanel;
    }
    case "VariableExplorer": {
      const m = await import("../components/Variables/VariableExplorer");
      _componentCache[name] = m.VariableExplorer;
      return m.VariableExplorer;
    }
    case "PlotPane": {
      const m = await import("../components/PlotPane/PlotPane");
      _componentCache[name] = m.PlotPane;
      return m.PlotPane;
    }
    case "TestRunnerPanel": {
      const m = await import("../components/TestRunner/TestRunnerPanel");
      _componentCache[name] = m.TestRunnerPanel;
      return m.TestRunnerPanel;
    }
    default:
      throw new Error(`Unknown component: ${name}`);
  }
}

/**
 * Register all built-in contributions into the plugin store.
 * Called once at app startup before rendering.
 */
export async function registerBuiltinContributions() {
  const store = usePluginStore.getState();

  // ─── Sidebar Panels ─────────────────────────────────────────────────────────

  const [FileExplorer, SearchPanel, GitPanel, ContainerPanel, OutlinePanel, VariableExplorer] =
    await Promise.all([
      getComponent("FileExplorer"),
      getComponent("SearchPanel"),
      getComponent("GitPanel"),
      getComponent("ContainerPanel"),
      getComponent("OutlinePanel"),
      getComponent("VariableExplorer"),
    ]);

  store.registerSidebarPanel({
    id: "files",
    label: "Explorer",
    icon: "Files",
    order: 10,
    component: FileExplorer,
  });
  store.registerSidebarPanel({
    id: "search",
    label: "Search",
    icon: "Search",
    order: 20,
    component: SearchPanel,
  });
  store.registerSidebarPanel({
    id: "git",
    label: "Source Control",
    icon: "GitBranch",
    order: 30,
    component: GitPanel,
  });
  store.registerSidebarPanel({
    id: "container",
    label: "Dev Containers",
    icon: "Container",
    order: 40,
    component: ContainerPanel,
  });
  store.registerSidebarPanel({
    id: "outline",
    label: "Outline",
    icon: "List",
    order: 15,
    component: OutlinePanel,
  });
  store.registerSidebarPanel({
    id: "variables",
    label: "Variables",
    icon: "Eye",
    order: 25,
    component: VariableExplorer,
  });

  // ─── Bottom Panels ──────────────────────────────────────────────────────────

  const [
    OutputPanel,
    TerminalPanel,
    DebugPanel,
    PackageManager,
    ContainerLogsPanel,
    PlotPane,
    TestRunnerPanel,
  ] = await Promise.all([
    getComponent("OutputPanel"),
    getComponent("TerminalPanel"),
    getComponent("DebugPanel"),
    getComponent("PackageManager"),
    getComponent("ContainerLogsPanel"),
    getComponent("PlotPane"),
    getComponent("TestRunnerPanel"),
  ]);

  store.registerBottomPanel({
    id: "output",
    label: "Output",
    order: 10,
    component: OutputPanel,
  });
  store.registerBottomPanel({
    id: "terminal",
    label: "Terminal",
    order: 20,
    component: TerminalPanel,
  });
  store.registerBottomPanel({
    id: "problems",
    label: "Problems",
    order: 30,
    badge: () => {
      const count = useIdeStore.getState().problems.length;
      return count > 0 ? count : null;
    },
  });
  store.registerBottomPanel({
    id: "debug",
    label: "Debug",
    order: 40,
    component: DebugPanel,
    badge: () => (useIdeStore.getState().debug.isDebugging ? "●" : null),
  });
  store.registerBottomPanel({
    id: "packages",
    label: "Packages",
    order: 50,
    component: PackageManager,
  });
  store.registerBottomPanel({
    id: "plots",
    label: "Plots",
    order: 15,
    component: PlotPane,
  });
  store.registerBottomPanel({
    id: "tests",
    label: "Tests",
    order: 35,
    component: TestRunnerPanel,
  });
  store.registerBottomPanel({
    id: "container-logs",
    label: "Container",
    order: 60,
    component: ContainerLogsPanel,
  });

  // ─── Commands ───────────────────────────────────────────────────────────────

  registerBuiltinCommands();
}

function registerBuiltinCommands() {
  const store = usePluginStore.getState();
  const ide = () => useIdeStore.getState();
  const settings = () => useSettingsStore.getState();

  store.registerCommand({
    id: "file.open-folder",
    label: "Open Folder",
    shortcut: "⌘O",
    execute: async () => {
      const path = await invoke<string | null>("dialog_open_folder");
      if (!path) return;
      const tree = await invoke<FileNode>("fs_get_tree", { path });
      ide().setWorkspace(path, tree);
    },
  });

  // Both of these open the Mode Bar in the matching mode. The separate Quick
  // Open and Command Palette overlays they used to drive are gone; the
  // shortcuts are unchanged so existing muscle memory still works.
  store.registerCommand({
    id: "file.quick-open",
    label: "Go to File",
    shortcut: "⌘P",
    execute: () => useModeBarStore.getState().openWith(""),
  });

  store.registerCommand({
    id: "view.command-palette",
    label: "Show Command Palette",
    shortcut: "⌘⇧P",
    execute: () => useModeBarStore.getState().openWith(">"),
  });

  store.registerCommand({
    id: "file.save",
    label: "Save File",
    shortcut: "⌘S",
    // Monaco owns the Ctrl/Cmd+S keybinding directly; this exists so the same
    // action is reachable from the application menu and the command palette.
    execute: async () => {
      const s = ide();
      const tab = s.openTabs.find((t) => t.id === s.activeTabId);
      if (!tab) return;
      const content = s.editorInstance?.getValue() ?? tab.content;
      await invoke("fs_write_file", { path: tab.path, content });
      s.markTabSaved(tab.id);
    },
  });

  store.registerCommand({
    id: "edit.find",
    label: "Find in File",
    shortcut: "⌘F",
    execute: () => ide().editorInstance?.getAction("actions.find")?.run(),
  });

  store.registerCommand({
    id: "edit.find-replace",
    label: "Find and Replace",
    shortcut: "⌘H",
    execute: () => ide().editorInstance?.getAction("editor.action.startFindReplaceAction")?.run(),
  });

  store.registerCommand({
    id: "search.global",
    label: "Search in Files",
    shortcut: "⌘⇧F",
    execute: () => ide().setActiveSidebarView("search"),
  });

  store.registerCommand({
    id: "settings.open",
    label: "Open Settings",
    shortcut: "⌘,",
    execute: () => settings().setSettingsOpen(true),
  });

  store.registerCommand({
    id: "editor.split",
    label: "Toggle Split Editor",
    execute: () => ide().toggleSplitEditor(),
  });

  store.registerCommand({
    id: "julia.run",
    label: "Run Julia File",
    shortcut: "⌃F5",
    execute: async () => {
      const s = ide();
      const activeTab = s.openTabs.find((t) => t.id === s.activeTabId);
      if (!activeTab) return;
      s.clearOutput();
      s.setActiveBottomPanel("output");
      s.setIsRunning(true);
      s.appendOutput({ kind: "info", text: `Running: ${activeTab.name}` });
      await invoke("julia_run", {
        filePath: activeTab.path,
        projectPath: s.workspacePath ?? null,
      }).catch((e) => s.appendOutput({ kind: "stderr", text: String(e) }));
    },
  });

  store.registerCommand({
    id: "julia.precompile",
    label: "Precompile Julia Project",
    execute: async () => {
      const s = ide();
      s.clearOutput();
      s.setActiveBottomPanel("output");
      s.appendOutput({ kind: "info", text: "Precompiling..." });
      await invoke("julia_precompile", { projectPath: s.workspacePath ?? null });
    },
  });

  store.registerCommand({
    id: "julia.clean",
    label: "Clean Build Artifacts",
    execute: async () => {
      const s = ide();
      s.clearOutput();
      s.setActiveBottomPanel("output");
      await invoke("julia_clean", { projectPath: s.workspacePath ?? null });
    },
  });

  store.registerCommand({
    id: "julia.stop",
    label: "Stop Julia Process",
    execute: async () => {
      await invoke("julia_kill");
      ide().setIsRunning(false);
    },
  });

  store.registerCommand({
    id: "julia.set-path",
    label: "Set Julia Executable Path",
    description: "Choose a custom Julia binary",
    // Routed through the store so the binary gets probed with --version, the
    // setting is persisted, and every surface re-detects afterwards.
    execute: () => useJuliaStore.getState().locateManually(),
  });

  store.registerCommand({
    id: "app.check-for-updates",
    label: "Check for Updates",
    description: "See whether a newer julIDE release is available",
    execute: async () => {
      const { useUpdateStore } = await import("../stores/useUpdateStore");
      const store = useUpdateStore.getState();
      await store.check();
      const s = useUpdateStore.getState();
      if (s.phase === "upToDate") {
        ide().appendOutput({ kind: "info", text: "julIDE is up to date." });
      } else if (s.phase === "error") {
        ide().appendOutput({ kind: "stderr", text: `Update check failed: ${s.error}` });
      }
    },
  });

  store.registerCommand({
    id: "julia.setup",
    label: "Julia: Setup",
    description: "Locate Julia and install the optional packages julIDE uses",
    execute: () => {
      useJuliaStore.getState().setSetupOpen(true);
    },
  });

  store.registerCommand({
    id: "julia.new-project-pkgtemplates",
    label: "Julia: New Project (PkgTemplates)",
    description: "Create a new Julia package using PkgTemplates.jl",
    execute: async () => {
      const s = ide();

      const parentDir = await invoke<string | null>("dialog_open_folder");
      if (!parentDir) return;

      const packageName = await showInputDialog({
        title: "Package Name",
        placeholder: "MyPackage",
        validate: (v) =>
          /^[A-Za-z][A-Za-z0-9]*$/.test(v)
            ? null
            : "Must start with a letter and contain only letters and digits",
      });
      if (!packageName) return;

      const userName = await showInputDialog({
        title: "Git Hosting Username",
        placeholder: "your-github-username",
        validate: (v) => (v.length > 0 ? null : "Username is required"),
      });
      if (!userName) return;

      s.clearOutput();
      s.setActiveBottomPanel("output");
      s.appendOutput({
        kind: "info",
        text: `Creating project "${packageName}" in ${parentDir}...`,
      });

      const unlisten = await listen<JuliaOutputEvent>("julia-output", async (event) => {
        if (event.payload.kind === "done") {
          unlisten();
          if (event.payload.exit_code === 0) {
            const projectPath = `${parentDir}/${packageName}`;
            try {
              const tree = await invoke<FileNode>("fs_get_tree", { path: projectPath });
              ide().setWorkspace(projectPath, tree);
            } catch (e) {
              ide().appendOutput({ kind: "stderr", text: `Failed to open project: ${e}` });
            }
          }
        }
      });

      await invoke("julia_create_project", {
        packageName,
        parentDir,
        userName,
      }).catch((e) => {
        s.appendOutput({ kind: "stderr", text: String(e) });
        unlisten();
      });
    },
  });

  store.registerCommand({
    id: "julia.new-project-bestie",
    label: "Julia: New Project (BestieTemplate)",
    description: "Create a new Julia package using BestieTemplate.jl",
    execute: async () => {
      const s = ide();

      const parentDir = await invoke<string | null>("dialog_open_folder");
      if (!parentDir) return;

      const data = await showBestieTemplateDialog();
      if (!data) return;

      s.clearOutput();
      s.setActiveBottomPanel("output");
      s.appendOutput({
        kind: "info",
        text: `Creating project "${data.packageName}" with BestieTemplate in ${parentDir}...`,
      });

      const unlisten = await listen<JuliaOutputEvent>("julia-output", async (event) => {
        if (event.payload.kind === "done") {
          unlisten();
          if (event.payload.exit_code === 0) {
            const projectPath = `${parentDir}/${data.packageName}.jl`;
            try {
              const tree = await invoke<FileNode>("fs_get_tree", { path: projectPath });
              ide().setWorkspace(projectPath, tree);
            } catch (e) {
              ide().appendOutput({ kind: "stderr", text: `Failed to open project: ${e}` });
            }
          }
        }
      });

      await invoke("julia_create_project_bestie", {
        parentDir,
        packageName: data.packageName,
        packageOwner: data.packageOwner,
        authors: data.authors,
        juliaMinVersion: data.juliaMinVersion,
        license: data.license,
        strategyLevel: data.strategyLevel,
      }).catch((e) => {
        s.appendOutput({ kind: "stderr", text: String(e) });
        unlisten();
      });
    },
  });

  store.registerCommand({
    id: "panel.output",
    label: "Show Output Panel",
    execute: () => ide().setActiveBottomPanel("output"),
  });

  store.registerCommand({
    id: "panel.terminal",
    label: "Show Terminal",
    shortcut: "⌃`",
    execute: () => ide().setActiveBottomPanel("terminal"),
  });

  store.registerCommand({
    id: "panel.problems",
    label: "Show Problems",
    execute: () => ide().setActiveBottomPanel("problems"),
  });

  store.registerCommand({
    id: "panel.debug",
    label: "Show Debug Panel",
    execute: () => ide().setActiveBottomPanel("debug"),
  });

  store.registerCommand({
    id: "output.clear",
    label: "Clear Output",
    execute: () => ide().clearOutput(),
  });

  store.registerCommand({
    id: "container.reopen",
    label: "Dev Containers: Reopen in Container",
    execute: async () => {
      const s = ide();
      if (!s.workspacePath) return;
      const st = settings().settings;
      s.setActiveBottomPanel("container-logs");
      await startDevcontainer(s.workspacePath, {
        displayForwarding: st.displayForwarding,
        gpuPassthrough: st.gpuPassthrough,
        selinuxLabel: st.selinuxLabel,
        persistJuliaPackages: st.persistJuliaPackages,
      }).catch((e) => console.error(e));
    },
  });

  store.registerCommand({
    id: "container.rebuild",
    label: "Dev Containers: Rebuild Container",
    execute: async () => {
      const s = ide();
      if (!s.workspacePath) return;
      const st = settings().settings;
      s.setActiveBottomPanel("container-logs");
      await startDevcontainer(
        s.workspacePath,
        {
          displayForwarding: st.displayForwarding,
          gpuPassthrough: st.gpuPassthrough,
          selinuxLabel: st.selinuxLabel,
          persistJuliaPackages: st.persistJuliaPackages,
        },
        "rebuild",
      ).catch((e) => console.error(e));
    },
  });

  store.registerCommand({
    id: "container.stop",
    label: "Dev Containers: Stop Container",
    execute: async () => {
      await invoke("devcontainer_stop").catch((e) => console.error(e));
    },
  });

  store.registerCommand({
    id: "container.logs",
    label: "Dev Containers: Show Container Logs",
    execute: () => ide().setActiveBottomPanel("container-logs"),
  });

  store.registerCommand({
    id: "container.panel",
    label: "Dev Containers: Show Container Panel",
    execute: () => ide().setActiveSidebarView("container"),
  });

  // ─── Git Commands ─────────────────────────────────────────────────────────

  store.registerCommand({
    id: "git.push",
    label: "Git: Push",
    category: "Git",
    execute: async () => {
      const s = ide();
      if (!s.workspacePath || !s.gitBranch) return;
      s.setGitIsSyncing(true);
      try {
        await invoke("git_push", {
          workspacePath: s.workspacePath,
          remote: "origin",
          branch: s.gitBranch,
        });
        await s.refreshGit();
      } catch (e) {
        s.appendOutput({ kind: "stderr", text: `Git push failed: ${e}` });
      } finally {
        s.setGitIsSyncing(false);
      }
    },
  });

  store.registerCommand({
    id: "git.pull",
    label: "Git: Pull",
    category: "Git",
    execute: async () => {
      const s = ide();
      if (!s.workspacePath || !s.gitBranch) return;
      s.setGitIsSyncing(true);
      try {
        await invoke("git_pull", {
          workspacePath: s.workspacePath,
          remote: "origin",
          branch: s.gitBranch,
        });
        await s.refreshGit();
      } catch (e) {
        s.appendOutput({ kind: "stderr", text: `Git pull failed: ${e}` });
      } finally {
        s.setGitIsSyncing(false);
      }
    },
  });

  store.registerCommand({
    id: "git.fetch",
    label: "Git: Fetch",
    category: "Git",
    execute: async () => {
      const s = ide();
      if (!s.workspacePath) return;
      s.setGitIsSyncing(true);
      try {
        await invoke("git_fetch", { workspacePath: s.workspacePath, remote: "origin" });
        await s.refreshGit();
      } catch (e) {
        s.appendOutput({ kind: "stderr", text: `Git fetch failed: ${e}` });
      } finally {
        s.setGitIsSyncing(false);
      }
    },
  });

  store.registerCommand({
    id: "git.stash",
    label: "Git: Stash Changes",
    category: "Git",
    execute: async () => {
      const s = ide();
      if (!s.workspacePath) return;
      try {
        await invoke("git_stash_save", { workspacePath: s.workspacePath, message: "" });
        await s.refreshGit();
      } catch (e) {
        s.appendOutput({ kind: "stderr", text: `Git stash failed: ${e}` });
      }
    },
  });

  store.registerCommand({
    id: "git.stash-pop",
    label: "Git: Pop Stash",
    category: "Git",
    execute: async () => {
      const s = ide();
      if (!s.workspacePath) return;
      try {
        await invoke("git_stash_pop", { workspacePath: s.workspacePath, index: 0 });
        await s.refreshGit();
      } catch (e) {
        s.appendOutput({ kind: "stderr", text: `Git stash pop failed: ${e}` });
      }
    },
  });

  store.registerCommand({
    id: "git.panel",
    label: "Git: Show Source Control",
    execute: () => ide().setActiveSidebarView("git"),
  });

  store.registerCommand({
    id: "editor.go-to-line",
    label: "Go to Line",
    shortcut: "⌘G",
    execute: () => ide().editorInstance?.getAction("editor.action.gotoLine")?.run(),
  });

  store.registerCommand({
    id: "editor.format-document",
    label: "Format Document",
    execute: () => ide().editorInstance?.getAction("editor.action.formatDocument")?.run(),
  });

  store.registerCommand({
    id: "lint.workspace",
    label: "Lint Workspace",
    execute: async () => {
      const s = ide();
      if (!s.workspacePath) return;
      const found = await invoke<Problem[]>("fatou_lint_workspace", {
        path: s.workspacePath,
      });
      // Keep the language server's live diagnostics and replace only the
      // previous lint pass. Files with an open buffer already have per-keystroke
      // diagnostics, so dropping the lint copy for those avoids showing each
      // finding twice — and avoids stale ones for unsaved edits.
      const fromLsp = ide().problems.filter((p) => p.id.startsWith("lsp-"));
      const liveFiles = new Set(fromLsp.map((p) => p.file));
      ide().setProblems([...fromLsp, ...found.filter((p) => !liveFiles.has(p.file))]);
    },
  });

  store.registerCommand({
    id: "outline.show",
    label: "Show Outline",
    execute: () => ide().setActiveSidebarView("outline"),
  });

  store.registerCommand({
    id: "variables.show",
    label: "Show Variable Explorer",
    execute: () => ide().setActiveSidebarView("variables"),
  });

  store.registerCommand({
    id: "plots.show",
    label: "Show Plot Pane",
    execute: () => ide().setActiveBottomPanel("plots"),
  });

  store.registerCommand({
    id: "git.toggle-blame",
    label: "Git: Toggle Inline Blame",
    execute: () => {
      const s = ide();
      s.setBlameEnabled(!s.blameEnabled);
    },
  });

  store.registerCommand({
    id: "tests.show",
    label: "Show Test Runner",
    execute: () => ide().setActiveBottomPanel("tests"),
  });

  store.registerCommand({
    id: "editor.run-cell",
    label: "Run Code Cell (Ctrl+Enter)",
    shortcut: "⌘↵",
    execute: () => {
      // Trigger via the editor action
      const editor = ide().editorInstance;
      if (editor) {
        editor.trigger("command-palette", "editor.action.triggerSuggest", null);
      }
    },
  });
}
