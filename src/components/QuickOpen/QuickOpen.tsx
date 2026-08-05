import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useModalA11y } from "../../hooks/useModalA11y";
import { invoke } from "@tauri-apps/api/core";
import { useIdeStore } from "../../stores/useIdeStore";
import type { FileNode, EditorTab } from "../../types";

interface FlatFile {
  name: string;
  path: string;
  relativePath: string;
}

function flattenTree(node: FileNode, prefix: string): FlatFile[] {
  const result: FlatFile[] = [];
  if (!node.is_dir) {
    result.push({ name: node.name, path: node.path, relativePath: prefix + node.name });
    return result;
  }
  if (node.children) {
    for (const child of node.children) {
      result.push(...flattenTree(child, prefix + node.name + "/"));
    }
  }
  return result;
}

function fuzzyMatch(query: string, target: string): number {
  const lower = target.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastMatchIdx = -1;

  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) {
      score += 1;
      // Consecutive matches score higher
      if (lastMatchIdx === i - 1) score += 2;
      // Matches at word boundaries score higher
      if (i === 0 || target[i - 1] === "/" || target[i - 1] === "_" || target[i - 1] === "-") {
        score += 3;
      }
      lastMatchIdx = i;
      qi++;
    }
  }

  return qi === q.length ? score : -1;
}

export function QuickOpen() {
  const open = useIdeStore((s) => s.quickOpenOpen);
  const setOpen = useIdeStore((s) => s.setQuickOpenOpen);
  const fileTree = useIdeStore((s) => s.fileTree);
  const openFile = useIdeStore((s) => s.openFile);

  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const allFiles = useMemo(() => {
    if (!fileTree) return [];
    return flattenTree(fileTree, "");
  }, [fileTree]);

  const filtered = useMemo(() => {
    if (!query.trim()) return allFiles.slice(0, 50);
    const scored = allFiles
      .map((f) => ({ file: f, score: fuzzyMatch(query, f.relativePath) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, 50).map((r) => r.file);
  }, [query, allFiles]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setSelectedIdx(0);
  }, [setOpen]);

  // Global Cmd+P handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "p" && !e.shiftKey) {
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === "Escape" && open) close();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, close, setOpen]);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  // Traps Tab inside the dialog and restores focus to wherever it was on close.
  const dialogRef = useModalA11y<HTMLDivElement>(open, { skipInitialFocus: true });

  if (!open) return null;

  const openSelected = async () => {
    const file = filtered[selectedIdx];
    if (!file) return;
    close();
    try {
      const content = await invoke<string>("fs_read_file", { path: file.path });
      const tab: EditorTab = {
        id: file.path,
        path: file.path,
        name: file.name,
        content,
        isDirty: false,
        language: file.name.split(".").pop() ?? "plaintext",
      };
      openFile(tab);
    } catch (e) {
      console.error("Failed to open file:", e);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      openSelected();
    } else if (e.key === "Escape") {
      close();
    }
  };

  return (
    <div className="command-palette-overlay" onClick={close}>
      <div
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Go to file"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="command-palette-input"
          placeholder="Search files by name..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="command-palette-list">
          {filtered.length === 0 ? (
            <div className="command-palette-empty">No files found</div>
          ) : (
            filtered.map((file, idx) => (
              <div
                key={file.path}
                className={`command-palette-item ${idx === selectedIdx ? "selected" : ""}`}
                onClick={() => {
                  close();
                  invoke<string>("fs_read_file", { path: file.path }).then((content) => {
                    openFile({
                      id: file.path,
                      path: file.path,
                      name: file.name,
                      content,
                      isDirty: false,
                      language: file.name.split(".").pop() ?? "plaintext",
                    });
                  });
                }}
                onMouseEnter={() => setSelectedIdx(idx)}
              >
                <span className="command-label">{file.name}</span>
                <span className="command-desc">{file.relativePath}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
