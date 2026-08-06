import { Files, Search, GitBranch, Settings, Container, Puzzle, List, Eye } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useIdeStore } from "../../stores/useIdeStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { usePluginStore } from "../../stores/usePluginStore";
import { iconSize } from "../../themes/tokens";

const ICON_MAP: Record<string, LucideIcon> = {
  Files,
  Search,
  GitBranch,
  Container,
  Puzzle,
  List,
  Eye,
};

/**
 * The left rail.
 *
 * Each destination now carries a text label under its icon. An icon-only rail
 * is the single largest discoverability tax in this UI: julIDE ships an
 * outline view, a variable explorer and dev container tooling that nobody
 * finds by hovering unfamiliar glyphs one at a time. Condensed type is what
 * makes the labels fit — see src/styles/fonts.css.
 *
 * Users who prefer the compact rail can turn labels off in Settings.
 */
export function ActivityBar() {
  const activeSidebarView = useIdeStore((s) => s.activeSidebarView);
  const setActiveSidebarView = useIdeStore((s) => s.setActiveSidebarView);
  const setSettingsOpen = useSettingsStore((s) => s.setSettingsOpen);
  const showLabels = useSettingsStore((s) => s.settings.activityBarLabels);
  const sidebarPanels = usePluginStore((s) => s.sidebarPanels);

  return (
    <nav
      className={`activity-bar${showLabels ? "" : " compact"}`}
      aria-label="Views"
      data-testid="activity-bar"
    >
      <div className="activity-bar-top">
        {sidebarPanels.map((panel) => {
          const Icon = ICON_MAP[panel.icon] || Puzzle;
          const active = activeSidebarView === panel.id;
          return (
            <button
              key={panel.id}
              className={`activity-bar-btn ${active ? "active" : ""}`}
              onClick={() => setActiveSidebarView(panel.id)}
              // The label is visible when labels are on, so the tooltip is
              // only doing work in compact mode — but aria-current still has
              // to say which view is showing.
              title={panel.label}
              aria-current={active ? "page" : undefined}
            >
              <Icon size={iconSize.lg} aria-hidden="true" />
              <span className="activity-bar-label">{panel.label}</span>
            </button>
          );
        })}
      </div>
      <div className="activity-bar-bottom">
        <button className="activity-bar-btn" onClick={() => setSettingsOpen(true)} title="Settings">
          <Settings size={iconSize.lg} aria-hidden="true" />
          <span className="activity-bar-label">Settings</span>
        </button>
      </div>
    </nav>
  );
}
