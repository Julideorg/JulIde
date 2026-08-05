import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openExternal } from "../../services/openExternal";
import { CircleDot, Plus, ExternalLink, RefreshCw } from "lucide-react";
import { useIdeStore } from "../../stores/useIdeStore";
import type { GitIssue } from "../../types/git";

export function GitIssuesTab() {
  const workspacePath = useIdeStore((s) => s.workspacePath);

  const [issues, setIssues] = useState<GitIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"open" | "closed" | "all">("open");
  const [creating, setCreating] = useState(false);
  const [newIssue, setNewIssue] = useState({ title: "", body: "" });

  const fetchIssues = async () => {
    if (!workspacePath) return;
    setLoading(true);
    try {
      const result = await invoke<GitIssue[]>("git_provider_list_issues", {
        workspacePath,
        state: filter,
      });
      setIssues(result);
      setError("");
    } catch (e) {
      setError(String(e));
      setIssues([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchIssues();
  }, [workspacePath, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  const createIssue = async () => {
    if (!workspacePath || !newIssue.title.trim()) return;
    try {
      await invoke("git_provider_create_issue", {
        workspacePath,
        title: newIssue.title,
        body: newIssue.body,
        labels: [],
      });
      setCreating(false);
      setNewIssue({ title: "", body: "" });
      await fetchIssues();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="git-issues-tab">
      <div className="git-section-header">
        <span>Issues</span>
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
          <button className="git-file-action" onClick={() => setCreating(!creating)} title="Create Issue">
            <Plus size={12} />
          </button>
          <button className="git-file-action" onClick={fetchIssues} title="Refresh">
            <RefreshCw size={12} />
          </button>
        </div>
      </div>

      {error && <div className="git-error">{error}</div>}

      {creating && (
        <div className="git-create-pr">
          <input
            className="git-commit-input"
            placeholder="Issue Title..."
            value={newIssue.title}
            onChange={(e) => setNewIssue({ ...newIssue, title: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && createIssue()}
            autoFocus
          />
          <textarea
            className="git-commit-input git-pr-body"
            placeholder="Description (optional)..."
            value={newIssue.body}
            onChange={(e) => setNewIssue({ ...newIssue, body: e.target.value })}
            rows={3}
          />
          <button
            className="btn-primary git-commit-btn"
            onClick={createIssue}
            disabled={!newIssue.title.trim()}
          >
            Create Issue
          </button>
        </div>
      )}

      {loading ? (
        <div className="git-panel-empty"><p>Loading...</p></div>
      ) : issues.length === 0 ? (
        <div className="git-panel-empty"><p>No issues</p></div>
      ) : (
        <div className="git-pr-list">
          {issues.map((issue) => (
            <div key={issue.number} className="git-pr-item">
              <div className="git-pr-item-header">
                <CircleDot size={13} className={`git-issue-icon ${issue.state}`} />
                <span className="git-pr-title" title={issue.title}>
                  #{issue.number} {issue.title}
                </span>
              </div>
              <div className="git-pr-item-meta">
                <span>{issue.author}</span>
                {issue.labels.length > 0 && (
                  <span className="git-issue-labels">
                    {issue.labels.map((l) => (
                      <span key={l} className="git-label">{l}</span>
                    ))}
                  </span>
                )}
              </div>
              <div className="git-pr-item-actions">
                <button
                  className="git-file-action"
                  onClick={() => openExternal(issue.url).catch(console.error)}
                  title="Open in browser"
                >
                  <ExternalLink size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
