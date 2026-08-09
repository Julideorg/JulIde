import { invoke } from "@tauri-apps/api/core";
import {
  Play,
  Zap,
  Trash2,
  Bug,
  Square,
  StepForward,
  CornerDownRight,
  CornerUpLeft,
  FolderOpen,
  RefreshCw,
  BookOpen,
  Container,
} from "lucide-react";
import { useIdeStore } from "../../stores/useIdeStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { usePluginStore } from "../../stores/usePluginStore";
import { startDevcontainer } from "../../services/devcontainer";
import { Select } from "../ui";
import { ModeBarTrigger } from "../ModeBar/ModeBar";
import type { FileNode } from "../../types";

export function Toolbar() {
  const plutoPort = useSettingsStore((s) => s.settings.plutoPort);
  const isRunning = useIdeStore((s) => s.isRunning);
  const debug = useIdeStore((s) => s.debug);
  const setIsRunning = useIdeStore((s) => s.setIsRunning);
  const clearOutput = useIdeStore((s) => s.clearOutput);
  const appendOutput = useIdeStore((s) => s.appendOutput);
  const setActiveBottomPanel = useIdeStore((s) => s.setActiveBottomPanel);
  const activeTabId = useIdeStore((s) => s.activeTabId);
  const openTabs = useIdeStore((s) => s.openTabs);
  const workspacePath = useIdeStore((s) => s.workspacePath);
  const juliaEnv = useIdeStore((s) => s.juliaEnv);
  const availableEnvs = useIdeStore((s) => s.availableEnvs);
  const setJuliaEnv = useIdeStore((s) => s.setJuliaEnv);
  const setWorkspace = useIdeStore((s) => s.setWorkspace);
  const setDebugState = useIdeStore((s) => s.setDebugState);
  const reviseEnabled = useIdeStore((s) => s.reviseEnabled);
  const setReviseEnabled = useIdeStore((s) => s.setReviseEnabled);
  const containerMode = useIdeStore((s) => s.containerMode);
  const containerId = useIdeStore((s) => s.containerId);
  const devcontainerDetected = useIdeStore((s) => s.devcontainerDetected);
  const pluginToolbarButtons = usePluginStore((s) => s.toolbarButtons);

  const activeTab = openTabs.find((t) => t.id === activeTabId) ?? null;

  const handleRun = async () => {
    if (!activeTab) {
      appendOutput({ kind: "info", text: "No file open to run." });
      return;
    }
    clearOutput();
    setActiveBottomPanel("output");
    setIsRunning(true);
    appendOutput({ kind: "info", text: `Running: ${activeTab.name}` });
    try {
      if (containerMode && containerId) {
        await invoke("container_julia_run", {
          containerId,
          filePath: activeTab.path,
          projectPath: workspacePath ?? null,
        });
      } else {
        await invoke("julia_run", {
          filePath: activeTab.path,
          projectPath: workspacePath ?? null,
        });
      }
    } catch (e) {
      appendOutput({ kind: "stderr", text: `Error: ${e}` });
      setIsRunning(false);
    }
  };

  const handlePrecompile = async () => {
    clearOutput();
    setActiveBottomPanel("output");
    appendOutput({ kind: "info", text: "Precompiling..." });
    try {
      await invoke("julia_precompile", {
        projectPath: workspacePath ?? null,
      });
    } catch (e) {
      appendOutput({ kind: "stderr", text: `Precompile error: ${e}` });
    }
  };

  const handleClean = async () => {
    clearOutput();
    setActiveBottomPanel("output");
    appendOutput({ kind: "info", text: "Cleaning..." });
    try {
      await invoke("julia_clean", {
        projectPath: workspacePath ?? null,
      });
    } catch (e) {
      appendOutput({ kind: "stderr", text: `Clean error: ${e}` });
    }
  };

  const handleStop = async () => {
    try {
      await invoke("julia_kill");
    } catch (e) {
      console.error(e);
    }
    setIsRunning(false);
  };

  const handleDebug = async () => {
    if (!activeTab) return;
    setActiveBottomPanel("debug");
    setDebugState({ isDebugging: true });
    appendOutput({ kind: "info", text: `Debugging: ${activeTab.name}` });
    try {
      await invoke("debug_start", {
        filePath: activeTab.path,
        projectPath: workspacePath ?? null,
      });
    } catch (e) {
      appendOutput({ kind: "stderr", text: `Debug error: ${e}` });
      setDebugState({ isDebugging: false });
    }
  };

  const handleDebugContinue = () => invoke("debug_continue").catch(console.error);
  const handleStepOver = () => invoke("debug_step_over").catch(console.error);
  const handleStepInto = () => invoke("debug_step_into").catch(console.error);
  const handleStepOut = () => invoke("debug_step_out").catch(console.error);
  const handleDebugStop = async () => {
    await invoke("debug_stop").catch(console.error);
    setDebugState({ isDebugging: false, isPaused: false });
  };

  const handleOpenPluto = async () => {
    try {
      useIdeStore.getState().setPlutoNotebookPath("");
      await invoke("pluto_open", {
        notebookPath: "",
        workspacePath: workspacePath ?? null,
        port: plutoPort,
      });
    } catch (e) {
      appendOutput({ kind: "stderr", text: `Pluto error: ${e}` });
    }
  };

  const handleOpenFolder = async () => {
    try {
      const path = await invoke<string | null>("dialog_open_folder");
      if (!path) return;
      const tree = await invoke<FileNode>("fs_get_tree", { path });
      setWorkspace(path, tree);
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <button
          className="toolbar-btn btn-icon"
          title="Open Folder"
          aria-label="Open Folder"
          onClick={handleOpenFolder}
        >
          <FolderOpen size={16} />
        </button>

        <div className="toolbar-separator" />

        {isRunning ? (
          <button
            className="toolbar-btn btn-danger"
            onClick={handleStop}
            title="Stop"
            aria-label="Stop"
          >
            <Square size={15} />
            <span>Stop</span>
          </button>
        ) : (
          <button
            className="toolbar-btn btn-run"
            onClick={handleRun}
            title="Run (Ctrl+F5)"
            aria-label="Run (Ctrl+F5)"
            disabled={!activeTab}
          >
            <Play size={15} />
            <span>Run</span>
          </button>
        )}

        <button
          className="toolbar-btn btn-precompile"
          onClick={handlePrecompile}
          disabled={isRunning}
          title="Precompile project"
          aria-label="Precompile project"
        >
          <Zap size={15} />
          <span>Precompile</span>
        </button>

        <button
          className="toolbar-btn btn-clean"
          onClick={handleClean}
          disabled={isRunning}
          title="Clean build artifacts"
          aria-label="Clean build artifacts"
        >
          <Trash2 size={15} />
          <span>Clean</span>
        </button>

        <div className="toolbar-separator" />

        {debug.isDebugging ? (
          <div className="toolbar-debug-controls">
            <button
              className="toolbar-btn btn-debug"
              onClick={handleDebugContinue}
              title="Continue (F5)"
              aria-label="Continue (F5)"
            >
              <Play size={14} />
            </button>
            <button
              className="toolbar-btn"
              onClick={handleStepOver}
              title="Step Over (F10)"
              aria-label="Step Over (F10)"
            >
              <StepForward size={14} />
            </button>
            <button
              className="toolbar-btn"
              onClick={handleStepInto}
              title="Step Into (F11)"
              aria-label="Step Into (F11)"
            >
              <CornerDownRight size={14} />
            </button>
            <button
              className="toolbar-btn"
              onClick={handleStepOut}
              title="Step Out (Shift+F11)"
              aria-label="Step Out (Shift+F11)"
            >
              <CornerUpLeft size={14} />
            </button>
            <button
              className="toolbar-btn btn-danger"
              onClick={handleDebugStop}
              title="Stop Debug"
              aria-label="Stop Debug"
            >
              <Square size={14} />
            </button>
          </div>
        ) : (
          <button
            className="toolbar-btn btn-debug"
            onClick={handleDebug}
            disabled={!activeTab || isRunning}
            title="Debug (F5)"
            aria-label="Debug (F5)"
          >
            <Bug size={15} />
            <span>Debug</span>
          </button>
        )}

        <div className="toolbar-separator" />

        <button
          className={`toolbar-btn ${reviseEnabled ? "btn-revise-on" : "btn-revise"}`}
          onClick={() => setReviseEnabled(!reviseEnabled)}
          title={
            reviseEnabled
              ? "Revise.jl hot-reload enabled (click to disable)"
              : "Enable Revise.jl hot-reload"
          }
        >
          <RefreshCw size={15} />
          <span>Revise</span>
        </button>

        <button
          className="toolbar-btn btn-pluto"
          onClick={handleOpenPluto}
          title="Open Pluto notebook server"
          aria-label="Open Pluto notebook server"
        >
          <BookOpen size={15} />
          <span>Pluto</span>
        </button>

        {devcontainerDetected && !containerMode && (
          <>
            <div className="toolbar-separator" />
            <button
              className="toolbar-btn btn-container"
              onClick={async () => {
                if (!workspacePath) return;
                const { useSettingsStore: settingsStore } =
                  await import("../../stores/useSettingsStore");
                const s = settingsStore.getState().settings;
                clearOutput();
                setActiveBottomPanel("container-logs");
                try {
                  await startDevcontainer(workspacePath, {
                    displayForwarding: s.displayForwarding,
                    gpuPassthrough: s.gpuPassthrough,
                    selinuxLabel: s.selinuxLabel,
                    persistJuliaPackages: s.persistJuliaPackages,
                  });
                } catch (e) {
                  appendOutput({ kind: "stderr", text: `Container error: ${e}` });
                }
              }}
              title="Reopen in Dev Container"
              aria-label="Reopen in Dev Container"
            >
              <Container size={15} />
              <span>Container</span>
            </button>
          </>
        )}

        {/* Plugin-contributed toolbar buttons */}
        {pluginToolbarButtons.length > 0 && (
          <>
            <div className="toolbar-separator" />
            {pluginToolbarButtons.map((btn) => {
              const isVisible = btn.visible ? btn.visible() : true;
              const isDisabled = btn.disabled ? btn.disabled() : false;
              if (!isVisible) return null;
              // Same as the status bar: plugin buttons are data, and `component` is
              // only for julIDE's own built-ins.
              if (btn.component) {
                return <btn.component key={btn.id} />;
              }
              return (
                <button
                  key={btn.id}
                  className="toolbar-btn"
                  onClick={btn.onClick}
                  disabled={isDisabled}
                  title={btn.label}
                >
                  <span>{btn.label}</span>
                </button>
              );
            })}
          </>
        )}
      </div>

      {/* The one visible door to every feature. Centred so it reads as the
          app's entry point rather than another toolbar button. */}
      <div className="toolbar-center">
        <ModeBarTrigger />
      </div>

      <div className="toolbar-right">
        {/* A <span>, not a <label>: it has no htmlFor, and a label associated with a
            button toggles it on click — which would immediately re-close the dropdown. */}
        <span className="env-selector-label">Env:</span>
        <Select
          className="env-selector"
          ariaLabel="Julia environment"
          value={juliaEnv}
          onChange={setJuliaEnv}
          options={availableEnvs.map((env) => ({ value: env, label: env }))}
        />
      </div>
    </div>
  );
}
