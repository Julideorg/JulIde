import { useCallback, useRef } from "react";
import { Code, Eye, X } from "lucide-react";
import { useIdeStore } from "../../stores/useIdeStore";
import { isMarkdownPath } from "../../markdown/renderer";

export function EditorTabs() {
  const openTabs = useIdeStore((s) => s.openTabs);
  const activeTabId = useIdeStore((s) => s.activeTabId);
  const setActiveTab = useIdeStore((s) => s.setActiveTab);
  const closeTab = useIdeStore((s) => s.closeTab);
  const reorderTabs = useIdeStore((s) => s.reorderTabs);
  const toggleTabViewMode = useIdeStore((s) => s.toggleTabViewMode);

  const dragIndexRef = useRef<number | null>(null);

  const handleClose = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      closeTab(id);
    },
    [closeTab],
  );

  const handleTogglePreview = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      toggleTabViewMode(id);
    },
    [toggleTabViewMode],
  );

  const handleMiddleClick = useCallback(
    (e: React.MouseEvent, id: string) => {
      if (e.button === 1) {
        e.preventDefault();
        closeTab(id);
      }
    },
    [closeTab],
  );

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
          {tab.isDirty && (
            <span className="editor-tab-dirty" title="Unsaved changes">
              ●
            </span>
          )}
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
          <button
            className="editor-tab-close"
            onClick={(e) => handleClose(e, tab.id)}
            title="Close"
            aria-label="Close"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
