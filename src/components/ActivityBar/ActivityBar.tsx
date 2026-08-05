import { Files, Search, GitBranch, Settings, Container, Puzzle, List, Eye } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useIdeStore } from "../../stores/useIdeStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { usePluginStore } from "../../stores/usePluginStore";

const ICON_MAP: Record<string, LucideIcon> = {
  Files,
  Search,
  GitBranch,
  Container,
  Puzzle,
  List,
  Eye,
};

export function ActivityBar() {
  const activeSidebarView = useIdeStore((s) => s.activeSidebarView);
  const setActiveSidebarView = useIdeStore((s) => s.setActiveSidebarView);
  const setSettingsOpen = useSettingsStore((s) => s.setSettingsOpen);
  const sidebarPanels = usePluginStore((s) => s.sidebarPanels);

  const toggle = (viewId: string) => {
    setActiveSidebarView(activeSidebarView === viewId ? viewId : viewId);
  };

  return (
    <div className="activity-bar">
      <div className="activity-bar-top">
        {sidebarPanels.map((panel) => {
          const Icon = ICON_MAP[panel.icon] || Puzzle;
          return (
            <button
              key={panel.id}
              className={`activity-bar-btn ${activeSidebarView === panel.id ? "active" : ""}`}
              onClick={() => toggle(panel.id)}
              title={panel.label}
            >
              <Icon size={20} />
            </button>
          );
        })}
      </div>
      <div className="activity-bar-bottom">
        <button
          className="activity-bar-btn"
          onClick={() => setSettingsOpen(true)}
          title="Settings"
          aria-label="Settings"
        >
          <Settings size={20} />
        </button>
      </div>
    </div>
  );
}
