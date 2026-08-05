import { useState, useEffect } from "react";
import { useIdeStore } from "../../stores/useIdeStore";
import { GitChangesTab } from "./GitChangesTab";
import { GitBranchesTab } from "./GitBranchesTab";
import { GitPRsTab } from "./GitPRsTab";
import { GitIssuesTab } from "./GitIssuesTab";

type GitTab = "changes" | "branches" | "prs" | "issues";

export function GitPanel() {
  const workspacePath = useIdeStore((s) => s.workspacePath);
  const gitIsRepo = useIdeStore((s) => s.gitIsRepo);
  const gitProvider = useIdeStore((s) => s.gitProvider);
  const refreshGit = useIdeStore((s) => s.refreshGit);
  const [activeTab, setActiveTab] = useState<GitTab>("changes");

  useEffect(() => {
    refreshGit();
  }, [workspacePath]); // eslint-disable-line react-hooks/exhaustive-deps -- refreshGit is a stable store action; this should re-run on workspace change only

  if (!workspacePath) {
    return (
      <div className="git-panel-empty">
        <p>Open a workspace to use source control</p>
      </div>
    );
  }

  if (!gitIsRepo) {
    return (
      <div className="git-panel-empty">
        <p>This workspace is not a git repository</p>
      </div>
    );
  }

  const tabs: { id: GitTab; label: string; visible: boolean }[] = [
    { id: "changes", label: "Changes", visible: true },
    { id: "branches", label: "Branches", visible: true },
    { id: "prs", label: "PRs", visible: !!gitProvider },
    { id: "issues", label: "Issues", visible: !!gitProvider },
  ];

  return (
    <div className="git-panel">
      <div className="git-tab-bar">
        {tabs
          .filter((t) => t.visible)
          .map((tab) => (
            <button
              key={tab.id}
              className={`git-tab ${activeTab === tab.id ? "active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
      </div>

      <div className="git-tab-content">
        {activeTab === "changes" && <GitChangesTab />}
        {activeTab === "branches" && <GitBranchesTab />}
        {activeTab === "prs" && <GitPRsTab />}
        {activeTab === "issues" && <GitIssuesTab />}
      </div>
    </div>
  );
}
