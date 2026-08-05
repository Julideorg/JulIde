import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openExternal } from "../../services/openExternal";
import { GitPullRequest, Plus, ExternalLink, GitMerge, RefreshCw } from "lucide-react";
import { useIdeStore } from "../../stores/useIdeStore";
import type { GitPullRequest as PR } from "../../types/git";

export function GitPRsTab() {
  const workspacePath = useIdeStore((s) => s.workspacePath);
  const gitBranch = useIdeStore((s) => s.gitBranch);
  const gitBranches = useIdeStore((s) => s.gitBranches);

  const [prs, setPrs] = useState<PR[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"open" | "closed" | "all">("open");
  const [creating, setCreating] = useState(false);
  const [newPr, setNewPr] = useState({ title: "", body: "", source: "", target: "" });

  const fetchPRs = async () => {
    if (!workspacePath) return;
    setLoading(true);
    try {
      const result = await invoke<PR[]>("git_provider_list_prs", {
        workspacePath,
        state: filter,
      });
      setPrs(result);
      setError("");
    } catch (e) {
      setError(String(e));
      setPrs([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPRs();
  }, [workspacePath, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  const createPR = async () => {
    if (!workspacePath || !newPr.title.trim()) return;
    try {
      await invoke("git_provider_create_pr", {
        workspacePath,
        title: newPr.title,
        body: newPr.body,
        source: newPr.source || gitBranch,
        target: newPr.target || "main",
      });
      setCreating(false);
      setNewPr({ title: "", body: "", source: "", target: "" });
      await fetchPRs();
    } catch (e) {
      setError(String(e));
    }
  };

  const mergePR = async (number: number) => {
    if (!workspacePath) return;
    try {
      await invoke("git_provider_merge_pr", { workspacePath, number });
      await fetchPRs();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="git-prs-tab">
      <div className="git-section-header">
        <span>Pull Requests</span>
        <div className="git-pr-actions">
          <select
            className="git-pr-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
          >
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
          <button className="git-file-action" onClick={() => setCreating(!creating)} title="Create PR">
            <Plus size={12} />
          </button>
          <button className="git-file-action" onClick={fetchPRs} title="Refresh">
            <RefreshCw size={12} />
          </button>
        </div>
      </div>

      {error && <div className="git-error">{error}</div>}

      {creating && (
        <div className="git-create-pr">
          <input
            className="git-commit-input"
            placeholder="PR Title..."
            value={newPr.title}
            onChange={(e) => setNewPr({ ...newPr, title: e.target.value })}
            autoFocus
          />
          <textarea
            className="git-commit-input git-pr-body"
            placeholder="Description (optional)..."
            value={newPr.body}
            onChange={(e) => setNewPr({ ...newPr, body: e.target.value })}
            rows={3}
          />
          <div className="git-pr-branch-row">
            <select
              className="git-pr-filter"
              value={newPr.source || gitBranch}
              onChange={(e) => setNewPr({ ...newPr, source: e.target.value })}
            >
              {gitBranches.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
            <span className="git-pr-arrow">→</span>
            <input
              className="git-commit-input"
              placeholder="Target branch (main)"
              value={newPr.target}
              onChange={(e) => setNewPr({ ...newPr, target: e.target.value })}
              style={{ flex: 1 }}
            />
          </div>
          <button
            className="btn-primary git-commit-btn"
            onClick={createPR}
            disabled={!newPr.title.trim()}
          >
            Create Pull Request
          </button>
        </div>
      )}

      {loading ? (
        <div className="git-panel-empty"><p>Loading...</p></div>
      ) : prs.length === 0 ? (
        <div className="git-panel-empty"><p>No pull requests</p></div>
      ) : (
        <div className="git-pr-list">
          {prs.map((pr) => (
            <div key={pr.number} className="git-pr-item">
              <div className="git-pr-item-header">
                <GitPullRequest size={13} className={`git-pr-icon ${pr.state}`} />
                <span className="git-pr-title" title={pr.title}>
                  #{pr.number} {pr.title}
                </span>
              </div>
              <div className="git-pr-item-meta">
                <span>{pr.author}</span>
                <span>{pr.sourceBranch} → {pr.targetBranch}</span>
              </div>
              <div className="git-pr-item-actions">
                <button
                  className="git-file-action"
                  onClick={() => openExternal(pr.url).catch(console.error)}
                  title="Open in browser"
                >
                  <ExternalLink size={12} />
                </button>
                {pr.state === "open" && (
                  <button
                    className="git-file-action"
                    onClick={() => mergePR(pr.number)}
                    title="Merge"
                  >
                    <GitMerge size={12} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
