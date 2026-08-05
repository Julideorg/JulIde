import { useEffect, useRef, useCallback, useReducer } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Toolbar } from "./components/Toolbar/Toolbar";
import { EditorSplitContainer } from "./components/Editor/EditorSplitContainer";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { CommandPalette } from "./components/CommandPalette/CommandPalette";
import { QuickOpen } from "./components/QuickOpen/QuickOpen";
import { SettingsPanel } from "./components/Settings/SettingsPanel";
import { InputDialog } from "./components/InputDialog/InputDialog";
import { BestieTemplateDialog } from "./components/BestieTemplateDialog/BestieTemplateDialog";
import { ActivityBar } from "./components/ActivityBar/ActivityBar";
import { WelcomeScreen } from "./components/Welcome/WelcomeScreen";
import { JuliaSetupDialog } from "./components/Welcome/JuliaSetupDialog";
import { PluginPanel } from "./components/Plugin/PluginPanel";
import { PluginConsentDialog } from "./components/Plugin/PluginConsentDialog";
import { WorkspaceTrustDialog } from "./components/Container/WorkspaceTrustDialog";
import { UpdateBanner } from "./components/Update/UpdateBanner";
import { useSettingsStore } from "./stores/useSettingsStore";
import { useIdeStore } from "./stores/useIdeStore";
import { usePluginStore } from "./stores/usePluginStore";
import { lspClient } from "./lsp/LspClient";
import { setMonacoMarkers } from "./lsp/juliaProviders";
import type { JuliaOutputEvent } from "./types";
import { parseMimeLine } from "./utils/juliaOutput";
import type { LspPublishDiagnosticsParams } from "./lsp/LspClient";
import type {
  ContainerOutputEvent,
  ContainerState,
  ContainerStatusEvent,
  DevContainerConfig,
  Problem,
} from "./types";
import "./App.css";

export default function App() {
  const activeBottomPanel = useIdeStore((s) => s.activeBottomPanel);
  const setActiveBottomPanel = useIdeStore((s) => s.setActiveBottomPanel);
  const bottomPanelHeight = useIdeStore((s) => s.bottomPanelHeight);
  const setBottomPanelHeight = useIdeStore((s) => s.setBottomPanelHeight);
  const sidebarWidth = useIdeStore((s) => s.sidebarWidth);
  const setSidebarWidth = useIdeStore((s) => s.setSidebarWidth);
  const problems = useIdeStore((s) => s.problems);
  const debug = useIdeStore((s) => s.debug);

  const workspacePath = useIdeStore((s) => s.workspacePath);
  const activeSidebarView = useIdeStore((s) => s.activeSidebarView);
  const setActiveSidebarView = useIdeStore((s) => s.setActiveSidebarView);
  const setLspStatus = useIdeStore((s) => s.setLspStatus);
  const setLspBackend = useIdeStore((s) => s.setLspBackend);
  const loadSettings = useSettingsStore((s) => s.loadSettings);

  // Plugin store — dynamic panels
  const sidebarPanels = usePluginStore((s) => s.sidebarPanels);
  const bottomPanels = usePluginStore((s) => s.bottomPanels);

  // Load settings on mount
  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // Restore the persisted layout once settings arrive. Runs on the load
  // transition only, so it never fights an in-progress drag.
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  useEffect(() => {
    if (!settingsLoaded) return;
    const { sidebarWidth: w, bottomPanelHeight: h } = useSettingsStore.getState().settings;
    if (w) setSidebarWidth(w);
    if (h) setBottomPanelHeight(h);
  }, [settingsLoaded, setSidebarWidth, setBottomPanelHeight]);
  const setProblems = useIdeStore((s) => s.setProblems);
  const setPlutoStatus = useIdeStore((s) => s.setPlutoStatus);
  const setFileTree = useIdeStore((s) => s.setFileTree);
  const getProblems = () => useIdeStore.getState().problems;

  const refreshGit = useIdeStore((s) => s.refreshGit);

  // File watcher: start when workspace opens
  useEffect(() => {
    if (!workspacePath) return;
    invoke("watcher_start", { workspacePath }).catch(console.error);
    // Also refresh git state when workspace opens
    refreshGit();
    return () => {
      invoke("watcher_stop").catch(console.error);
    };
    // Zustand actions are stable, so refreshGit is deliberately not a dep: including
    // it would not change behaviour, and the watcher must restart only on workspace change.
  }, [workspacePath]); // eslint-disable-line react-hooks/exhaustive-deps -- see above

  // Handle fs-changed events: refresh tree, reload open file content
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    let gitDebounce: ReturnType<typeof setTimeout> | null = null;

    listen<{ path: string; kind: string }>("fs-changed", (e) => {
      // Debounce tree refresh (many events can fire rapidly)
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        const wp = useIdeStore.getState().workspacePath;
        if (!wp) return;
        try {
          const tree = await invoke<import("./types").FileNode>("fs_get_tree", { path: wp });
          setFileTree(tree);
        } catch {
          /* ignore */
        }
      }, 500);

      // Also debounce git state refresh
      if (gitDebounce) clearTimeout(gitDebounce);
      gitDebounce = setTimeout(() => {
        useIdeStore.getState().refreshGit();
      }, 1000);

      // Reload open file if modified externally and not dirty
      if (e.payload.kind === "modify") {
        const state = useIdeStore.getState();
        const tab = state.openTabs.find((t) => t.path === e.payload.path);
        if (tab && !tab.isDirty) {
          invoke<string>("fs_read_file", { path: tab.path })
            .then((content) => {
              if (content !== tab.content) {
                state.updateTabContent(tab.id, content, false);
              }
            })
            .catch(() => {});
        }
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
      if (debounceTimer) clearTimeout(debounceTimer);
      if (gitDebounce) clearTimeout(gitDebounce);
    };
  }, [setFileTree]);

  // LSP lifecycle: start when workspace opens, stop when it closes
  useEffect(() => {
    if (!workspacePath) return;
    lspClient.start(workspacePath).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      setLspStatus("error", msg);
    });
    return () => {
      lspClient.stop().catch(console.error);
    };
    // setLspStatus is a stable store action; restarting the language server on any
    // other change would be wrong — it must track the workspace only.
  }, [workspacePath]); // eslint-disable-line react-hooks/exhaustive-deps -- see above

  // Mirror Rust lsp-status events into the store
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ status: string; message?: string; backend?: string }>("lsp-status", (e) => {
      setLspStatus(e.payload.status as "off" | "starting" | "ready" | "error", e.payload.message);
      if (e.payload.backend) {
        setLspBackend(e.payload.backend);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
    // Mount-only: one backend event subscription for the app's lifetime. Store
    // setters in the body are stable, so re-subscribing would only churn listeners.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- see above

  // Mirror Rust pluto-status events into the store and open split view
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<{ status: string; message?: string }>("pluto-status", async (e) => {
      const status = e.payload.status as "off" | "starting" | "ready" | "error";
      setPlutoStatus(status, e.payload.message);

      if (status === "ready" && e.payload.message) {
        const store = useIdeStore.getState();
        store.openPlutoSplit(e.payload.message, store.plutoNotebookPath);

        // Open the notebook file in the left editor pane
        const nbPath = store.plutoNotebookPath;
        if (nbPath) {
          const existing = store.openTabs.find((t) => t.path === nbPath);
          if (existing) {
            store.setActiveTab(existing.id);
          } else {
            try {
              const content = await invoke<string>("fs_read_file", { path: nbPath });
              const name = nbPath.split(/[/\\]/).pop() ?? "notebook.jl";
              store.openFile({
                id: `${Date.now()}-${Math.random()}`,
                path: nbPath,
                name,
                content,
                isDirty: false,
                language: "julia",
              });
            } catch {
              // File may not exist yet (new notebook)
            }
          }
        }
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
    // Mount-only: one backend event subscription for the app's lifetime. Store
    // setters in the body are stable, so re-subscribing would only churn listeners.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- see above

  // Mirror container-status events into the store
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<ContainerStatusEvent>("container-status", (e) => {
      const store = useIdeStore.getState();
      store.setContainerState(e.payload.status as ContainerState);
      if (e.payload.container_id) store.setContainerId(e.payload.container_id);
      if (e.payload.message) store.setContainerName(e.payload.message);
      if (e.payload.status === "running") store.setContainerMode(true);
      if (e.payload.status === "stopped" || e.payload.status === "none") {
        store.setContainerMode(false);
        store.setContainerId(null);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  // Mirror container-output events into the store
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<ContainerOutputEvent>("container-output", (e) => {
      const store = useIdeStore.getState();
      store.appendContainerLog({
        kind: e.payload.kind as "stdout" | "stderr" | "info" | "done",
        text: e.payload.text,
      });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  // Mirror julia-output events into the store
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    listen<JuliaOutputEvent>("julia-output", (event) => {
      const { kind, text, exit_code } = event.payload;
      const store = useIdeStore.getState();

      if (kind === "done") {
        store.setIsRunning(false);
        store.appendOutput({
          kind: "info",
          text: `Process exited with code ${exit_code ?? -1}`,
        });
        return;
      }

      if (kind === "stdout") {
        const mime = parseMimeLine(text);

        if (mime) {
          store.appendOutput({
            kind: "stdout",
            text: "",
            mime,
          });
        } else {
          store.appendOutput({
            kind: "stdout",
            text,
          });
        }
        return;
      }

      if (kind === "stderr") {
        store.appendOutput({
          kind: "stderr",
          text,
        });
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, []);

  // Auto-detect devcontainer.json when workspace opens
  useEffect(() => {
    if (!workspacePath) return;
    const autoDetect = useSettingsStore.getState().settings.containerAutoDetect;
    if (!autoDetect) return;
    invoke<boolean>("devcontainer_detect", { workspacePath })
      .then((detected) => {
        useIdeStore.getState().setDevcontainerDetected(detected);
        if (detected) {
          invoke<DevContainerConfig>("devcontainer_load_config", { workspacePath })
            .then((config) => useIdeStore.getState().setDevcontainerConfig(config))
            .catch(() => {});
        }
      })
      .catch(() => useIdeStore.getState().setDevcontainerDetected(false));
  }, [workspacePath]);

  // Route LSP publishDiagnostics notifications to the store and Monaco markers
  useEffect(() => {
    const unsubscribe = lspClient.onNotification((method, params) => {
      if (method !== "textDocument/publishDiagnostics") return;
      const { uri, diagnostics } = params as LspPublishDiagnosticsParams;
      const filePath = uri.replace(/^file:\/\//, "");

      const otherProblems = getProblems().filter((p) => p.file !== filePath);
      const newProblems: Problem[] = diagnostics.map((d, i) => ({
        id: `lsp-${filePath}-${i}`,
        file: filePath,
        line: d.range.start.line + 1,
        col: d.range.start.character + 1,
        severity: d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info",
        message: d.message,
      }));
      setProblems([...otherProblems, ...newProblems]);
      setMonacoMarkers(uri, diagnostics);
    });
    return unsubscribe;
    // Mount-only: a single LSP diagnostics subscription. It reads the latest problems
    // via useIdeStore.getState() rather than closing over them, so it needs no deps.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- see above

  const isDraggingBottomRef = useRef(false);
  const isDraggingSidebarRef = useRef(false);
  const dragStartYRef = useRef(0);
  const dragStartHRef = useRef(0);
  const dragStartXRef = useRef(0);
  const dragStartWRef = useRef(0);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "`") {
        e.preventDefault();
        setActiveBottomPanel("terminal");
      }
      // Cmd/Ctrl+Shift+F for global search
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "F") {
        e.preventDefault();
        setActiveSidebarView("search");
      }
      // Cmd/Ctrl+G for Go to Line
      if ((e.ctrlKey || e.metaKey) && e.key === "g") {
        e.preventDefault();
        const editor = useIdeStore.getState().editorInstance;
        if (editor) {
          editor.getAction("editor.action.gotoLine")?.run();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setActiveBottomPanel, setActiveSidebarView]);

  const onBottomDragStart = useCallback(
    (e: React.MouseEvent) => {
      isDraggingBottomRef.current = true;
      dragStartYRef.current = e.clientY;
      dragStartHRef.current = bottomPanelHeight;
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [bottomPanelHeight],
  );

  const onSidebarDragStart = useCallback(
    (e: React.MouseEvent) => {
      isDraggingSidebarRef.current = true;
      dragStartXRef.current = e.clientX;
      dragStartWRef.current = sidebarWidth;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [sidebarWidth],
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (isDraggingBottomRef.current) {
        const delta = dragStartYRef.current - e.clientY;
        const newH = Math.max(80, Math.min(600, dragStartHRef.current + delta));
        setBottomPanelHeight(newH);
      }
      if (isDraggingSidebarRef.current) {
        const delta = e.clientX - dragStartXRef.current;
        const newW = Math.max(150, Math.min(480, dragStartWRef.current + delta));
        setSidebarWidth(newW);
      }
    };
    const onMouseUp = () => {
      const wasDragging = isDraggingBottomRef.current || isDraggingSidebarRef.current;
      isDraggingBottomRef.current = false;
      isDraggingSidebarRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";

      // Persist on drag end, not on every mousemove: a single write per gesture
      // instead of one per pixel.
      if (wasDragging) {
        const s = useIdeStore.getState();
        void useSettingsStore.getState().updateSettings({
          sidebarWidth: s.sidebarWidth,
          bottomPanelHeight: s.bottomPanelHeight,
        });
      }
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [setBottomPanelHeight, setSidebarWidth]);

  // Find the active sidebar panel
  const activeSidebar = sidebarPanels.find((p) => p.id === activeSidebarView);

  // Track which bottom panels have ever been activated so we can keep them
  // mounted (hidden via display:none) instead of unmounting on tab switch.
  // Preserves Terminal REPL state, scroll positions, etc.
  const mountedBottomPanelsRef = useRef<Set<string>>(new Set());
  const [, forceMountedTick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (activeBottomPanel && !mountedBottomPanelsRef.current.has(activeBottomPanel)) {
      mountedBottomPanelsRef.current.add(activeBottomPanel);
      forceMountedTick();
    }
  }, [activeBottomPanel]);

  const currentTheme = useSettingsStore((s) => s.settings.theme);
  const themeClass = currentTheme === "julide-light" ? "theme-light" : "theme-dark";

  return (
    <div
      className={`ide-root ${themeClass}`}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}
    >
      {/* Toolbar spans full width */}
      <div className="ide-toolbar-area">
        <Toolbar />
      </div>

      {/* Activity Bar */}
      <ActivityBar />

      {/* Sidebar */}
      <div className="ide-sidebar" style={{ width: sidebarWidth }}>
        {activeSidebar && (
          <PluginPanel
            key={activeSidebar.id}
            label={activeSidebar.label}
            component={activeSidebar.component}
            render={activeSidebar.render}
          />
        )}
      </div>

      {/* Sidebar resize handle */}
      <div
        className="sidebar-resize-handle"
        style={{ left: `calc(48px + ${sidebarWidth}px)` }}
        onMouseDown={onSidebarDragStart}
      />

      {/* Main content area */}
      <div className="ide-main">
        {/* Editor or Welcome Screen */}
        {!workspacePath && useIdeStore.getState().openTabs.length === 0 ? (
          <WelcomeScreen />
        ) : (
          <EditorSplitContainer />
        )}

        {/* Bottom panel resize handle */}
        <div className="bottom-panel-resize-handle" onMouseDown={onBottomDragStart} />

        {/* Bottom panel */}
        <div className="ide-bottom-panel" style={{ height: bottomPanelHeight }}>
          <div className="bottom-panel-tabs">
            {bottomPanels.map((panel) => (
              <button
                key={panel.id}
                className={`bottom-tab ${activeBottomPanel === panel.id ? "active" : ""}`}
                onClick={() => setActiveBottomPanel(panel.id)}
              >
                {panel.label}
                {panel.id === "problems" && problems.length > 0 && (
                  <span className="tab-badge">{problems.length}</span>
                )}
                {panel.id === "debug" && debug.isDebugging && (
                  <span className="tab-badge debug-badge">●</span>
                )}
                {panel.badge &&
                  panel.id !== "problems" &&
                  panel.id !== "debug" &&
                  (() => {
                    const val = panel.badge!();
                    return val != null ? <span className="tab-badge">{val}</span> : null;
                  })()}
              </button>
            ))}
          </div>
          <div className="bottom-panel-content">
            {bottomPanels
              .filter((panel) => mountedBottomPanelsRef.current.has(panel.id))
              .map((panel) => (
                <div
                  key={panel.id}
                  className="bottom-panel-slot"
                  style={{
                    display: panel.id === activeBottomPanel ? "flex" : "none",
                    flexDirection: "column",
                    width: "100%",
                    height: "100%",
                  }}
                >
                  {panel.id === "problems" ? (
                    <ProblemsPanel />
                  ) : (
                    <PluginPanel
                      label={panel.label}
                      component={panel.component}
                      render={panel.render}
                    />
                  )}
                </div>
              ))}
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div className="ide-statusbar-area">
        <StatusBar />
      </div>

      {/* Overlays */}
      <CommandPalette />
      <QuickOpen />
      <SettingsPanel />
      <InputDialog />
      <BestieTemplateDialog />
      <JuliaSetupDialog />
      <PluginConsentDialog />
      <WorkspaceTrustDialog />
      <UpdateBanner />
    </div>
  );
}

function ProblemsPanel() {
  const problems = useIdeStore((s) => s.problems);
  if (problems.length === 0) {
    return (
      <div className="problems-empty">
        <span>No problems detected.</span>
      </div>
    );
  }
  return (
    <div className="problems-list">
      {problems.map((p) => (
        <div key={p.id} className={`problem-item ${p.severity}`}>
          <span className="problem-severity">{p.severity === "error" ? "✕" : "⚠"}</span>
          <span className="problem-message">{p.message}</span>
          <span className="problem-location">
            {p.file.split(/[/\\]/).pop()}:{p.line}:{p.col}
          </span>
        </div>
      ))}
    </div>
  );
}
