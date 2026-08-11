import { useCallback, useRef } from "react";
import { Code, Eye, X } from "lucide-react";
import { useIdeStore } from "../../stores/useIdeStore";
import { useAscii } from "../../services/ascii";
import { isMarkdownPath } from "../../markdown/renderer";
import { requestCloseTab } from "../../services/requestCloseTab";

export function EditorTabs() {
  const ascii = useAscii();
  const openTabs = useIdeStore((s) => s.openTabs);
  const activeTabId = useIdeStore((s) => s.activeTabId);
  const setActiveTab = useIdeStore((s) => s.setActiveTab);
  const reorderTabs = useIdeStore((s) => s.reorderTabs);
  const toggleTabViewMode = useIdeStore((s) => s.toggleTabViewMode);

  const dragIndexRef = useRef<number | null>(null);

  // requestCloseTab, not the store's closeTab: a tab with unsaved changes asks first.
  const handleClose = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    void requestCloseTab(id);
  }, []);

  const handleTogglePreview = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      toggleTabViewMode(id);
    },
    [toggleTabViewMode],
  );

  const handleMiddleClick = useCallback((e: React.MouseEvent, id: string) => {
    if (e.button === 1) {
      e.preventDefault();
      void requestCloseTab(id);
    }
  }, []);

  const handleDragStart = (e: React.DragEvent, index: number) => {
    dragIndexRef.current = index;
    e.dataTransfer.effectAllowed = "move";
    // Make the drag ghost semi-transparent
    const target = e.currentTarget as HTMLElement;
    target.style.opacity = "0.5";
  };

  const handleDragEnd = (e: React.DragEvent) => {
    (e.currentTarget as HTMLElement).style.opacity = "";
    dragIndexRef.current = null;
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleDrop = (e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    const fromIndex = dragIndexRef.current;
    if (fromIndex !== null && fromIndex !== toIndex) {
      reorderTabs(fromIndex, toIndex);
    }
    dragIndexRef.current = null;
  };

  if (openTabs.length === 0) {
    return <div className="editor-tabs editor-tabs-empty" />;
  }

  return (
    <div className="editor-tabs">
      {openTabs.map((tab, index) => (
        <div
          key={tab.id}
          className={`editor-tab ${tab.id === activeTabId ? "active" : ""}`}
          onClick={() => setActiveTab(tab.id)}
          onMouseDown={(e) => handleMiddleClick(e, tab.id)}
          title={tab.path}
          draggable
          onDragStart={(e) => handleDragStart(e, index)}
          onDragEnd={handleDragEnd}
          onDragOver={handleDragOver}
          onDrop={(e) => handleDrop(e, index)}
        >
          <span className="editor-tab-name">{tab.name}</span>
          {isMarkdownPath(tab.path) && (
            <button
              className="editor-tab-preview"
              onClick={(e) => handleTogglePreview(e, tab.id)}
              title={tab.viewMode === "preview" ? "Show source" : "Show preview"}
              aria-label={tab.viewMode === "preview" ? "Show source" : "Show preview"}
              aria-pressed={tab.viewMode === "preview"}
            >
              {tab.viewMode === "preview" ? <Code size={12} /> : <Eye size={12} />}
            </button>
          )}
          {/*
            The dot and the close button share one slot, as they do in VS Code: the dot
            is what you see at rest, and hovering or focusing the tab turns it into an X.
            Both are always rendered — swapping which is *visible* is a CSS concern, and
            rendering the button conditionally would take it out of the tab order for
            exactly the tabs that most need closing deliberately.
          */}
          <span className={`editor-tab-slot ${tab.isDirty ? "dirty" : ""}`}>
            <span className="editor-tab-dirty" aria-hidden="true">
              {ascii("●")}
            </span>
            <button
              className="editor-tab-close"
              onClick={(e) => handleClose(e, tab.id)}
              title={tab.isDirty ? "Close (unsaved changes)" : "Close"}
              aria-label={tab.isDirty ? `Close ${tab.name}, unsaved changes` : `Close ${tab.name}`}
            >
              <X size={12} />
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
