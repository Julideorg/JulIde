import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { GitBranch, Plus, Trash2, Check } from "lucide-react";
import { useIdeStore } from "../../stores/useIdeStore";

export function GitBranchesTab() {
  const workspacePath = useIdeStore((s) => s.workspacePath);
  const gitBranch = useIdeStore((s) => s.gitBranch);
  const gitBranches = useIdeStore((s) => s.gitBranches);
  const refreshGit = useIdeStore((s) => s.refreshGit);

  const [creating, setCreating] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [error, setError] = useState("");

  const checkout = async (branch: string) => {
    if (!workspacePath || branch === gitBranch) return;
    try {
      await invoke("git_checkout_branch", { workspacePath, branch });
      await refreshGit();
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };

  const createBranch = async () => {
    if (!workspacePath || !newBranchName.trim()) return;
    try {
      await invoke("git_branch_create", {
        workspacePath,
        name: newBranchName.trim(),
        checkout: true,
      });
      setNewBranchName("");
      setCreating(false);
      await refreshGit();
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };

  const deleteBranch = async (branch: string) => {
    if (!workspacePath || branch === gitBranch) return;
    try {
      await invoke("git_branch_delete", { workspacePath, name: branch });
      await refreshGit();
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="git-branches-tab">
      <div className="git-section-header">
        <span>Branches</span>
        <button
          className="git-file-action"
          onClick={() => setCreating(!creating)}
          title="Create Branch"
          aria-label="Create Branch"
        >
          <Plus size={12} />
        </button>
      </div>

      {error && <div className="git-error">{error}</div>}

      {creating && (
        <div className="git-create-branch">
          <input
            className="git-commit-input"
            placeholder="New branch name..."
            value={newBranchName}
            onChange={(e) => setNewBranchName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") createBranch();
              if (e.key === "Escape") {
                setCreating(false);
                setNewBranchName("");
              }
            }}
            autoFocus
          />
          <button
            className="git-file-action"
            onClick={createBranch}
            disabled={!newBranchName.trim()}
            title="Create"
            aria-label="Create"
          >
            <Check size={12} />
          </button>
        </div>
      )}

      <div className="git-branch-list">
        {gitBranches.map((branch) => (
          <div
            key={branch}
            className={`git-branch-item ${branch === gitBranch ? "current" : ""}`}
            onClick={() => checkout(branch)}
          >
            <GitBranch size={13} />
            <span className="git-branch-item-name">{branch}</span>
            {branch === gitBranch && <span className="git-branch-current-badge">current</span>}
            {branch !== gitBranch && (
              <button
                className="git-file-action"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteBranch(branch);
                }}
                title="Delete branch"
                aria-label="Delete branch"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        ))}
        {gitBranches.length === 0 && (
          <div className="git-panel-empty">
            <p>No branches</p>
          </div>
        )}
      </div>
    </div>
  );
}
