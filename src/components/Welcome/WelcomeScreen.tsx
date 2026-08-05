import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, FolderOpen } from "lucide-react";
import { useIdeStore } from "../../stores/useIdeStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { useJuliaStore } from "../../stores/useJuliaStore";
import type { FileNode } from "../../types";

export function WelcomeScreen() {
  const setWorkspace = useIdeStore((s) => s.setWorkspace);
  const recentWorkspaces = useSettingsStore((s) => s.settings.recentWorkspaces);
  const juliaStatus = useJuliaStore((s) => s.status);
  const juliaVersion = useJuliaStore((s) => s.version);
  const detect = useJuliaStore((s) => s.detect);
  const setSetupOpen = useJuliaStore((s) => s.setSetupOpen);

  useEffect(() => {
    if (juliaStatus === "unknown") void detect();
  }, [juliaStatus, detect]);

  const openFolder = async () => {
    const path = await invoke<string | null>("dialog_open_folder");
    if (!path) return;
    const tree = await invoke<FileNode>("fs_get_tree", { path });
    setWorkspace(path, tree);
    invoke("settings_add_recent_workspace", { workspacePath: path }).catch(console.error);
  };

  const openRecent = async (path: string) => {
    try {
      const tree = await invoke<FileNode>("fs_get_tree", { path });
      setWorkspace(path, tree);
      invoke("settings_add_recent_workspace", { workspacePath: path }).catch(console.error);
    } catch (e) {
      // The directory was probably moved or deleted. Silently doing nothing here
      // made the button look broken, so surface it and drop the stale entry.
      console.error(`Could not open ${path}:`, e);
      useIdeStore.getState().appendOutput({
        kind: "stderr",
        text: `Could not open ${path} — it may have been moved or deleted.`,
      });
      invoke("settings_remove_recent_workspace", { workspacePath: path }).catch(() => {});
    }
  };

  return (
    <div className="welcome-screen">
      <div className="welcome-content">
        <h1 className="welcome-title">julIDE</h1>
        <p className="welcome-subtitle">An IDE for Julia</p>
        {juliaStatus === "missing" ? (
          <button
            type="button"
            className="welcome-julia-missing"
            onClick={() => setSetupOpen(true)}
          >
            <AlertTriangle size={14} />
            <span>Julia not found — click to set it up</span>
          </button>
        ) : (
          <p className="welcome-julia-version">
            {juliaStatus === "found" ? juliaVersion : "Detecting Julia…"}
          </p>
        )}

        <div className="welcome-actions">
          <button className="btn-primary welcome-open-btn" onClick={openFolder}>
            <FolderOpen size={16} /> Open Folder
          </button>
        </div>

        {recentWorkspaces.length > 0 && (
          <div className="welcome-recent">
            <h3 className="welcome-recent-title">Recent</h3>
            {recentWorkspaces.map((path) => (
              <button key={path} className="welcome-recent-item" onClick={() => openRecent(path)}>
                <span className="welcome-recent-name">{path.split(/[/\\]/).pop()}</span>
                <span className="welcome-recent-path">{path}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
