import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  GitBranch,
  RefreshCw,
  Plus,
  Minus,
  Check,
  ArrowUp,
  ArrowDown,
  RotateCw,
} from "lucide-react";
import { useIdeStore } from "../../stores/useIdeStore";
import { DiffViewer } from "./DiffViewer";

export function GitChangesTab() {
  const workspacePath = useIdeStore((s) => s.workspacePath);
  const gitBranch = useIdeStore((s) => s.gitBranch);
  const gitFiles = useIdeStore((s) => s.gitFiles);
  const gitAheadBehind = useIdeStore((s) => s.gitAheadBehind);
  const gitIsSyncing = useIdeStore((s) => s.gitIsSyncing);
  const setGitIsSyncing = useIdeStore((s) => s.setGitIsSyncing);
  const refreshGit = useIdeStore((s) => s.refreshGit);

  const [commitMsg, setCommitMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [diffFile, setDiffFile] = useState<{ path: string; status: string } | null>(null);

  const staged = gitFiles.filter((f) => f.staged);
  const unstaged = gitFiles.filter((f) => !f.staged && f.status !== "untracked");
  const untracked = gitFiles.filter((f) => f.status === "untracked");

  const stageFile = async (path: string) => {
    if (!workspacePath) return;
    try {
      await invoke("git_stage", { workspacePath, filePaths: [path] });
      await refreshGit();
    } catch (e) {
      setError(String(e));
    }
  };

  const unstageFile = async (path: string) => {
    if (!workspacePath) return;
    try {
      await invoke("git_unstage", { workspacePath, filePaths: [path] });
      await refreshGit();
    } catch (e) {
      setError(String(e));
    }
  };

  const stageAll = async () => {
    if (!workspacePath) return;
    const paths = [...unstaged, ...untracked].map((f) => f.path);
    if (paths.length === 0) return;
    try {
      await invoke("git_stage", { workspacePath, filePaths: paths });
      await refreshGit();
    } catch (e) {
      setError(String(e));
    }
  };

  const doCommit = async () => {
    if (!workspacePath || !commitMsg.trim()) return;
    setLoading(true);
    try {
      await invoke<string>("git_commit", { workspacePath, message: commitMsg.trim() });
      setCommitMsg("");
      await refreshGit();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const doPush = async () => {
    if (!workspacePath) return;
    setGitIsSyncing(true);
    try {
      await invoke("git_push", { workspacePath, remote: "origin", branch: gitBranch });
      await refreshGit();
    } catch (e) {
      setError(String(e));
    } finally {
      setGitIsSyncing(false);
    }
  };

  const doPull = async () => {
    if (!workspacePath) return;
    setGitIsSyncing(true);
    try {
      await invoke("git_pull", { workspacePath, remote: "origin", branch: gitBranch });
      await refreshGit();
    } catch (e) {
      setError(String(e));
    } finally {
      setGitIsSyncing(false);
    }
  };

  const doFetch = async () => {
    if (!workspacePath) return;
    setGitIsSyncing(true);
    try {
      await invoke("git_fetch", { workspacePath, remote: "origin" });
      await refreshGit();
    } catch (e) {
      setError(String(e));
    } finally {
      setGitIsSyncing(false);
    }
  };

  const statusIcon = (status: string) => {
    switch (status) {
      case "modified":
        return <span className="git-status-badge modified">M</span>;
      case "added":
        return <span className="git-status-badge added">A</span>;
      case "deleted":
        return <span className="git-status-badge deleted">D</span>;
      case "untracked":
        return <span className="git-status-badge untracked">U</span>;
      case "renamed":
        return <span className="git-status-badge renamed">R</span>;
      default:
        return <span className="git-status-badge">{status[0]?.toUpperCase()}</span>;
    }
  };

  if (diffFile) {
    return (
      <DiffViewer
        filePath={diffFile.path}
        fileStatus={diffFile.status}
        onClose={() => setDiffFile(null)}
      />
    );
  }

  return (
    <>
      {/* Header with branch and sync buttons */}
      <div className="git-panel-header">
        <GitBranch size={13} />
        <span className="git-branch-name">{gitBranch}</span>
        <div className="git-sync-buttons">
          <button
            className="git-sync-btn"
            onClick={doPush}
            disabled={gitIsSyncing}
            title={`Push${gitAheadBehind.ahead > 0 ? ` (${gitAheadBehind.ahead} ahead)` : ""}`}
          >
            <ArrowUp size={12} />
            {gitAheadBehind.ahead > 0 && (
              <span className="git-sync-count">{gitAheadBehind.ahead}</span>
            )}
          </button>
          <button
            className="git-sync-btn"
            onClick={doPull}
            disabled={gitIsSyncing}
            title={`Pull${gitAheadBehind.behind > 0 ? ` (${gitAheadBehind.behind} behind)` : ""}`}
          >
            <ArrowDown size={12} />
            {gitAheadBehind.behind > 0 && (
              <span className="git-sync-count">{gitAheadBehind.behind}</span>
            )}
          </button>
          <button
            className="git-sync-btn"
            onClick={doFetch}
            disabled={gitIsSyncing}
            title="Fetch"
            aria-label="Fetch"
          >
            <RotateCw size={12} className={gitIsSyncing ? "spinning" : ""} />
          </button>
          <button
            className="git-refresh-btn"
            onClick={refreshGit}
            title="Refresh"
            aria-label="Refresh"
          >
            <RefreshCw size={12} />
          </button>
        </div>
      </div>

      {error && <div className="git-error">{error}</div>}

      {/* Commit input */}
      <div className="git-commit-area">
        <input
          className="git-commit-input"
          placeholder="Commit message..."
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && doCommit()}
          disabled={loading}
        />
        <button
          className="btn-primary git-commit-btn"
          onClick={doCommit}
          disabled={loading || !commitMsg.trim() || staged.length === 0}
          title={staged.length === 0 ? "Stage changes first" : "Commit"}
        >
          <Check size={13} /> Commit
        </button>
      </div>

      <div className="git-file-list">
        {/* Staged Changes */}
        {staged.length > 0 && (
          <div className="git-section">
            <div className="git-section-header">
              <span>Staged Changes</span>
              <span className="git-section-count">{staged.length}</span>
            </div>
            {staged.map((f) => (
              <div key={`s-${f.path}`} className="git-file-item">
                {statusIcon(f.status)}
                <span
                  className="git-file-path"
                  onClick={() => setDiffFile({ path: f.path, status: f.status })}
                  title="View diff"
                >
                  {f.path}
                </span>
                <button
                  className="git-file-action"
                  onClick={() => unstageFile(f.path)}
                  title="Unstage"
                  aria-label="Unstage"
                >
                  <Minus size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Unstaged Changes */}
        {(unstaged.length > 0 || untracked.length > 0) && (
          <div className="git-section">
            <div className="git-section-header">
              <span>Changes</span>
              <span className="git-section-count">{unstaged.length + untracked.length}</span>
              <button
                className="git-file-action"
                onClick={stageAll}
                title="Stage All"
                aria-label="Stage All"
              >
                <Plus size={12} />
              </button>
            </div>
            {[...unstaged, ...untracked].map((f) => (
              <div key={`u-${f.path}`} className="git-file-item">
                {statusIcon(f.status)}
                <span
                  className="git-file-path"
                  onClick={() => setDiffFile({ path: f.path, status: f.status })}
                  title="View diff"
                >
                  {f.path}
                </span>
                <button
                  className="git-file-action"
                  onClick={() => stageFile(f.path)}
                  title="Stage"
                  aria-label="Stage"
                >
                  <Plus size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        {gitFiles.length === 0 && (
          <div className="git-panel-empty">
            <p>No changes</p>
          </div>
        )}
      </div>
    </>
  );
}
