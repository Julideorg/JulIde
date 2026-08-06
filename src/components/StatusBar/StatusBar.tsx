import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useIdeStore } from "../../stores/useIdeStore";
import { usePluginStore } from "../../stores/usePluginStore";
import { useJuliaStore } from "../../stores/useJuliaStore";
import { PluginPanel } from "../Plugin/PluginPanel";
import { Bug, Container, GitBranch, Play, Zap } from "lucide-react";
import { Dot, Menu, MenuItem, Popover } from "../ui";
import { iconSize } from "../../themes/tokens";

export function StatusBar() {
  const juliaVersion = useIdeStore((s) => s.juliaVersion);
  const juliaStatus = useJuliaStore((s) => s.status);
  const juliaDetectedVersion = useJuliaStore((s) => s.version);
  const detectJulia = useJuliaStore((s) => s.detect);
  const openJuliaSetup = useJuliaStore((s) => s.setSetupOpen);
  const juliaEnv = useIdeStore((s) => s.juliaEnv);
  const availableEnvs = useIdeStore((s) => s.availableEnvs);
  const setJuliaEnv = useIdeStore((s) => s.setJuliaEnv);
  const isRunning = useIdeStore((s) => s.isRunning);
  const debug = useIdeStore((s) => s.debug);
  const openTabs = useIdeStore((s) => s.openTabs);
  const activeTabId = useIdeStore((s) => s.activeTabId);
  const lspStatus = useIdeStore((s) => s.lspStatus);
  const lspErrorMessage = useIdeStore((s) => s.lspErrorMessage);
  const lspBackend = useIdeStore((s) => s.lspBackend);
  const reviseEnabled = useIdeStore((s) => s.reviseEnabled);
  const plutoStatus = useIdeStore((s) => s.plutoStatus);
  const plutoMessage = useIdeStore((s) => s.plutoMessage);
  const setJuliaVersion = useIdeStore((s) => s.setJuliaVersion);
  const setAvailableEnvs = useIdeStore((s) => s.setAvailableEnvs);

  const cursorLine = useIdeStore((s) => s.cursorLine);
  const cursorColumn = useIdeStore((s) => s.cursorColumn);
  const workspacePath = useIdeStore((s) => s.workspacePath);
  const activeTab = openTabs.find((t) => t.id === activeTabId);
  const [gitBranch, setGitBranch] = useState("");
  const pluginStatusItems = usePluginStore((s) => s.statusBarItems);

  useEffect(() => {
    if (!workspacePath) {
      setGitBranch("");
      return;
    }
    invoke<boolean>("git_is_repo", { workspacePath })
      .then((isRepo) => {
        if (isRepo) {
          invoke<string>("git_branch_current", { workspacePath })
            .then(setGitBranch)
            .catch(() => setGitBranch(""));
        } else {
          setGitBranch("");
        }
      })
      .catch(() => setGitBranch(""));
  }, [workspacePath]);

  // Detection lives in useJuliaStore so the welcome screen, the status bar, and the
  // setup dialog all agree — and so re-checking after a fix updates every surface.
  useEffect(() => {
    if (juliaStatus === "unknown") void detectJulia();
  }, [juliaStatus, detectJulia]);

  useEffect(() => {
    if (juliaStatus === "found") {
      setJuliaVersion(juliaDetectedVersion);
      invoke<string[]>("julia_list_environments")
        .then((envs) => setAvailableEnvs(envs))
        .catch(console.error);
    } else if (juliaStatus === "missing") {
      setJuliaVersion("Julia not found");
    }
  }, [juliaStatus, juliaDetectedVersion, setJuliaVersion, setAvailableEnvs]);

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        <Popover
          side="top"
          label="Julia runtime"
          trigger={(props) => (
            <button
              {...props}
              className={`status-item status-julia ${isRunning ? "running" : ""} ${debug.isDebugging ? "debugging" : ""} ${juliaStatus === "missing" ? "missing" : ""}`}
              title={juliaStatus === "missing" ? "Julia was not found" : juliaVersion}
            >
              {debug.isDebugging ? (
                <Bug size={iconSize.xs} />
              ) : isRunning ? (
                <Play size={iconSize.xs} />
              ) : (
                <Zap size={iconSize.xs} />
              )}
              <span className="status-value">
                {debug.isDebugging ? "Debugging" : isRunning ? "Running" : juliaVersion}
              </span>
            </button>
          )}
        >
          {(close) => (
            <Menu label="Julia runtime">
              <MenuItem
                onSelect={() => {
                  openJuliaSetup(true);
                  close();
                }}
              >
                {juliaStatus === "missing" ? "Set up Julia…" : "Julia setup and packages…"}
              </MenuItem>
              <MenuItem
                onSelect={() => {
                  void detectJulia();
                  close();
                }}
              >
                Re-detect Julia
              </MenuItem>
            </Menu>
          )}
        </Popover>
        <Popover
          side="top"
          label="Julia environment"
          trigger={(props) => (
            <button {...props} className="status-item status-env" title="Julia environment">
              <span className="status-value">@{juliaEnv.replace(/^@/, "")}</span>
            </button>
          )}
        >
          {(close) => (
            <Menu label="Julia environment">
              {availableEnvs.map((env) => (
                <MenuItem
                  key={env}
                  hint={env === juliaEnv ? "current" : undefined}
                  onSelect={() => {
                    setJuliaEnv(env);
                    close();
                  }}
                >
                  {env}
                </MenuItem>
              ))}
            </Menu>
          )}
        </Popover>
        {gitBranch && (
          <button
            className="status-item status-git"
            title={`On branch ${gitBranch} — open Source Control`}
            onClick={() => usePluginStore.getState().commands.get("git.panel")?.execute()}
          >
            <GitBranch size={iconSize.xs} />
            <span className="status-value">{gitBranch}</span>
          </button>
        )}
        {useIdeStore.getState().containerMode && (
          <span
            className={`status-item status-container status-container-${useIdeStore.getState().containerState}`}
            title={
              useIdeStore.getState().containerName
                ? `Container: ${useIdeStore.getState().containerName}`
                : "Dev Container"
            }
          >
            <Container size={11} />{" "}
            {useIdeStore.getState().containerState === "running"
              ? "Container"
              : useIdeStore.getState().containerState === "building"
                ? "Building..."
                : useIdeStore.getState().containerState === "starting"
                  ? "Starting..."
                  : useIdeStore.getState().containerState === "error"
                    ? "Container Err"
                    : "Container"}
          </span>
        )}
        {pluginStatusItems
          .filter((item) => item.alignment === "left")
          .map((item) => (
            <StatusBarPluginItem key={item.id} item={item} />
          ))}
      </div>

      <div className="status-center">
        <span className="status-item status-filename">{activeTab ? activeTab.name : "julIDE"}</span>
      </div>

      <div className="status-bar-right">
        {pluginStatusItems
          .filter((item) => item.alignment === "right")
          .map((item) => (
            <StatusBarPluginItem key={item.id} item={item} />
          ))}
        {activeTab && (
          <span className="status-item status-cursor" title="Cursor position">
            Ln {cursorLine}, Col {cursorColumn}
          </span>
        )}
        {activeTab && (
          <span className="status-item status-language">
            {activeTab.name.endsWith(".jl") ? "Julia" : "Text"}
          </span>
        )}
        <span className="status-item status-encoding">UTF-8</span>
        {reviseEnabled && (
          <span className="status-item status-revise" title="Revise.jl hot-reload active">
            <Dot tone="run" />
            Revise
          </span>
        )}
        {plutoStatus !== "off" && (
          <span
            className={`status-item status-pluto status-pluto-${plutoStatus}`}
            title={
              plutoStatus === "error"
                ? (plutoMessage ?? "Pluto error")
                : plutoStatus === "ready"
                  ? (plutoMessage ?? "Pluto running")
                  : "Pluto starting…"
            }
          >
            <Dot
              tone={
                plutoStatus === "ready" ? "brand" : plutoStatus === "starting" ? "help" : "shell"
              }
            />
            Pluto
          </span>
        )}
        <span
          className={`status-item status-lsp status-lsp-${lspStatus}`}
          title={
            lspStatus === "error"
              ? (lspErrorMessage ?? "LSP error")
              : `${lspBackend === "jetls" ? "JETLS.jl" : "LanguageServer.jl"}: ${lspStatus}`
          }
        >
          {lspStatus !== "off" && (
            <Dot
              tone={lspStatus === "ready" ? "run" : lspStatus === "starting" ? "help" : "shell"}
            />
          )}
          {lspBackend === "jetls" ? "JETLS" : "LSP"}
        </span>
      </div>
    </div>
  );
}

function StatusBarPluginItem({
  item,
}: {
  item: import("../../types/plugin").StatusBarItemContribution;
}) {
  if (item.component) {
    return <PluginPanel component={item.component} />;
  }
  if (item.render) {
    return <PluginPanel render={item.render} />;
  }
  const text = typeof item.text === "function" ? item.text() : item.text;
  return (
    <span
      className="status-item"
      title={item.tooltip}
      onClick={item.onClick}
      style={item.onClick ? { cursor: "pointer" } : undefined}
    >
      {text}
    </span>
  );
}
