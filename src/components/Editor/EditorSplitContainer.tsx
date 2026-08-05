import { useCallback, useRef, useEffect, useState } from "react";
import { X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { EditorTabs } from "./EditorTabs";
import { Breadcrumb } from "./Breadcrumb";
import { MonacoEditor } from "./MonacoEditor";
import { useIdeStore } from "../../stores/useIdeStore";

export function EditorSplitContainer() {
  const splitEditorOpen = useIdeStore((s) => s.splitEditorOpen);
  const splitTabId = useIdeStore((s) => s.splitTabId);
  const openTabs = useIdeStore((s) => s.openTabs);
  const plutoUrl = useIdeStore((s) => s.plutoUrl);
  const closePlutoSplit = useIdeStore((s) => s.closePlutoSplit);

  const splitTab = openTabs.find((t) => t.id === splitTabId) ?? null;

  const [splitWidth, setSplitWidth] = useState(50); // percentage
  const isDragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    isDragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setSplitWidth(Math.max(20, Math.min(80, pct)));
    };
    const onMouseUp = () => {
      isDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  const isPlutoSplit = !!plutoUrl;
  const isSplitActive = isPlutoSplit || (splitEditorOpen && !!splitTab);

  const handleClosePluto = useCallback(() => {
    closePlutoSplit();
    invoke("pluto_stop").catch(console.error);
  }, [closePlutoSplit]);

  if (!isSplitActive) {
    return (
      <>
        <EditorTabs />
        <Breadcrumb />
        <div className="ide-editor-area">
          <MonacoEditor />
        </div>
      </>
    );
  }

  return (
    <div ref={containerRef} className="split-editor-container">
      <div className="split-editor-pane" style={{ width: `${splitWidth}%` }}>
        <EditorTabs />
        <div className="ide-editor-area">
          <MonacoEditor />
        </div>
      </div>
      <div className="split-editor-handle" onMouseDown={onDragStart} />
      <div className="split-editor-pane" style={{ width: `${100 - splitWidth}%` }}>
        <div className="split-editor-tab-bar">
          {isPlutoSplit ? (
            <>
              <span className="split-editor-tab active">Pluto Notebook</span>
              <button
                className="pluto-split-close"
                onClick={handleClosePluto}
                title="Close Pluto"
                aria-label="Close Pluto"
              >
                <X size={12} />
              </button>
            </>
          ) : (
            <span className="split-editor-tab active">{splitTab!.name}</span>
          )}
        </div>
        {isPlutoSplit ? (
          <iframe
            src={plutoUrl}
            className="pluto-split-iframe"
            title="Pluto Notebook"
            // Pluto needs scripts and its own origin to work (websockets, storage),
            // and that origin is the local Pluto server — not julIDE's — so it still
            // cannot reach the Tauri IPC bridge. What this does buy us is blocking
            // allow-top-navigation: a notebook can no longer navigate the whole app
            // window away from under the user.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
          />
        ) : (
          <div className="ide-editor-area">
            <MonacoEditor key={`split-${splitTab!.id}`} />
          </div>
        )}
      </div>
    </div>
  );
}
