import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  Bug,
  Container,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Notebook,
  Terminal,
} from "lucide-react";
import { useIdeStore } from "../../stores/useIdeStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { containerSupported } from "../../services/containerSupport";
import { useJuliaStore } from "../../stores/useJuliaStore";
import { usePluginStore } from "../../stores/usePluginStore";
import { useModeBarStore } from "../ModeBar/ModeBar";
import { Button, Dot, Kbd, toast } from "../ui";
import { iconSize } from "../../themes/tokens";
import type { FileNode } from "../../types";

/**
 * What julIDE can do, named plainly.
 *
 * These are all shipped features that were reachable only from a menu or the
 * command palette, so in practice most users never met them. Naming them once
 * on the screen everyone sees first is the cheapest discoverability win
 * available; each entry opens the thing it describes.
 */
const CAPABILITIES: {
  icon: typeof Terminal;
  title: string;
  body: string;
  /** Omitted when the feature has no command to run — Pluto needs an open file. */
  command?: string;
}[] = [
  {
    icon: Terminal,
    title: "Julia REPL",
    body: "A real PTY-backed REPL with Revise.jl hot-reload.",
    command: "panel.terminal",
  },
  {
    icon: Bug,
    title: "Debugger",
    body: "Breakpoints, stepping and variable inspection via Debugger.jl.",
    command: "panel.debug",
  },
  {
    icon: GitBranch,
    title: "Source control",
    body: "Stage, commit, branch and browse pull requests without leaving the editor.",
    command: "git.panel",
  },
  {
    icon: Container,
    title: "Dev containers",
    body: "Detects devcontainer.json and builds it with Docker or Podman.",
    command: "container.panel",
  },
  {
    icon: Notebook,
    title: "Pluto notebooks",
    body: "Open a .jl file, then choose Pluto in the toolbar to run it as a reactive notebook.",
  },
];

export function WelcomeScreen() {
  const setWorkspace = useIdeStore((s) => s.setWorkspace);
  const recentWorkspaces = useSettingsStore((s) => s.settings.recentWorkspaces);
  const juliaStatus = useJuliaStore((s) => s.status);
  const juliaVersion = useJuliaStore((s) => s.version);
  const detect = useJuliaStore((s) => s.detect);
  const setSetupOpen = useJuliaStore((s) => s.setSetupOpen);
  const openModeBar = useModeBarStore((s) => s.openWith);

  useEffect(() => {
    if (juliaStatus === "unknown") void detect();
  }, [juliaStatus, detect]);

  const loadWorkspace = async (path: string) => {
    const tree = await invoke<FileNode>("fs_get_tree", { path });
    setWorkspace(path, tree);
    invoke("settings_add_recent_workspace", { workspacePath: path }).catch(console.error);
  };

  const openFolder = async () => {
    const path = await invoke<string | null>("dialog_open_folder");
    if (!path) return;
    await loadWorkspace(path);
  };

  const newProject = () => {
    // Registered by builtinContributions; runs the BestieTemplate generator.
    usePluginStore.getState().commands.get("julia.new-project-bestie")?.execute();
  };

  const openRecent = async (path: string) => {
    try {
      await loadWorkspace(path);
    } catch (e) {
      // The directory was probably moved or deleted. Silently doing nothing here
      // made the button look broken, so surface it and drop the stale entry.
      console.error(`Could not open ${path}:`, e);
      toast.warning("Could not open project", `${path} may have been moved or deleted.`);
      invoke("settings_remove_recent_workspace", { workspacePath: path }).catch(() => {});
    }
  };

  const runCommand = (id?: string) => {
    if (!id) return;
    usePluginStore.getState().commands.get(id)?.execute();
  };

  return (
    <div className="welcome-screen">
      <div className="welcome-content">
        <header className="welcome-header">
          <h1 className="welcome-title">
            jul<span className="welcome-title-accent">IDE</span>
          </h1>
          <p className="welcome-subtitle">An IDE for the Julia programming language</p>

          {juliaStatus === "missing" ? (
            <button
              type="button"
              className="welcome-julia-missing"
              onClick={() => setSetupOpen(true)}
            >
              <AlertTriangle size={iconSize.sm} />
              <span>Julia not found — click to set it up</span>
            </button>
          ) : (
            <p className="welcome-julia-version">
              <Dot tone={juliaStatus === "found" ? "run" : "help"} />
              <span className="tabular">
                {juliaStatus === "found" ? juliaVersion : "Detecting Julia…"}
              </span>
            </p>
          )}
        </header>

        <div className="welcome-actions">
          <Button
            variant="filled"
            tone="brand"
            size="md"
            onClick={openFolder}
            icon={<FolderOpen size={iconSize.sm} />}
          >
            Open folder
          </Button>
          <Button size="md" onClick={newProject} icon={<FolderPlus size={iconSize.sm} />}>
            New Julia project
          </Button>
        </div>

        <p className="welcome-hint">
          Press <Kbd>⌘K</Kbd> any time to find a file, run a command, or manage packages.
        </p>

        <div className="welcome-columns">
          {recentWorkspaces.length > 0 && (
            <section className="welcome-recent">
              <h2 className="welcome-section-title">Recent</h2>
              {recentWorkspaces.map((path) => (
                <button key={path} className="welcome-recent-item" onClick={() => openRecent(path)}>
                  <span className="welcome-recent-name">{path.split(/[/\\]/).pop()}</span>
                  <span className="welcome-recent-path">{path}</span>
                </button>
              ))}
            </section>
          )}

          <section className="welcome-capabilities">
            <h2 className="welcome-section-title">What's in here</h2>
            {CAPABILITIES.filter(
              (c) => c.command !== "container.panel" || containerSupported(),
            ).map(({ icon: Icon, title, body, command }) => {
              const Tag = command ? "button" : "div";
              return (
                <Tag
                  key={title}
                  className={`welcome-capability${command ? "" : " static"}`}
                  onClick={command ? () => runCommand(command) : undefined}
                >
                  <Icon size={iconSize.md} className="welcome-capability-icon" aria-hidden="true" />
                  <span className="welcome-capability-text">
                    <span className="welcome-capability-title">{title}</span>
                    <span className="welcome-capability-body">{body}</span>
                  </span>
                </Tag>
              );
            })}
          </section>
        </div>

        <button className="welcome-browse" onClick={() => openModeBar(">")}>
          Browse all commands
        </button>
      </div>
    </div>
  );
}
