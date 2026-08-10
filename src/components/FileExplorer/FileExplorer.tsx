import { useState, useCallback, useRef } from "react";
import {
  Folder,
  FolderOpen,
  FileText,
  FilePlus,
  FolderPlus,
  Trash2,
  Edit2,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  Check,
  X,
  BookOpen,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useIdeStore } from "../../stores/useIdeStore";
import { openFileAtPath } from "../../services/openFile";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { showConfirm } from "../ui";
import type { FileNode } from "../../types";

// Inline prompt that works in Tauri (replaces window.prompt which returns null)
interface InlinePromptProps {
  placeholder: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}
function InlinePrompt({ placeholder, onConfirm, onCancel }: InlinePromptProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="inline-prompt" onClick={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        autoFocus
        className="inline-prompt-input"
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim()) onConfirm(value.trim());
          if (e.key === "Escape") onCancel();
        }}
      />
      <button
        className="inline-prompt-btn confirm"
        onClick={() => value.trim() && onConfirm(value.trim())}
        title="Confirm"
        aria-label="Confirm"
      >
        <Check size={11} />
      </button>
      <button
        className="inline-prompt-btn cancel"
        onClick={onCancel}
        title="Cancel"
        aria-label="Cancel"
      >
        <X size={11} />
      </button>
    </div>
  );
}

function getFileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase();
  return <FileText size={14} className={`file-icon ext-${ext}`} />;
}

interface FileTreeNodeProps {
  node: FileNode;
  depth: number;
  onOpen: (node: FileNode) => void;
  onRefresh: () => void;
}

function FileTreeNode({ node, depth, onOpen, onRefresh }: FileTreeNodeProps) {
  const [expanded, setExpanded] = useState(depth === 0);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(node.name);
  const [promptMode, setPromptMode] = useState<"file" | "folder" | null>(null);
  const [plutoPromptMode, setPlutoPromptMode] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const handleClick = useCallback(() => {
    if (node.is_dir) {
      setExpanded((e) => !e);
    } else {
      onOpen(node);
    }
  }, [node, onOpen]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const closeMenu = () => setContextMenu(null);

  const handleDelete = async () => {
    closeMenu();
    // The name is interpolated into React text, never markup: workspaces are
    // routinely cloned from other people's repos, and a file called
    // `<img src=x onerror=...>` would otherwise run with full IPC access.
    const confirmed = await showConfirm(`"${node.name}" will be deleted permanently.`, {
      title: node.is_dir ? "Delete folder?" : "Delete file?",
      confirmLabel: "Delete",
    });
    if (!confirmed) return;
    try {
      await invoke("fs_delete_entry", { path: node.path });
      onRefresh();
    } catch (e) {
      console.error("Delete failed:", e);
    }
  };

  const handleOpenAsPluto = () => {
    closeMenu();
    useIdeStore.getState().setPlutoNotebookPath(node.path);
    const workspacePath = useIdeStore.getState().workspacePath;
    const plutoPort = useSettingsStore.getState().settings.plutoPort;
    invoke("pluto_open", {
      notebookPath: node.path,
      workspacePath: workspacePath ?? null,
      port: plutoPort,
    }).catch(console.error);
  };

  const handleNewFile = () => {
    closeMenu();
    setExpanded(true);
    setPromptMode("file");
  };

  const handleNewFolder = () => {
    closeMenu();
    setExpanded(true);
    setPromptMode("folder");
  };

  const handleRename = () => {
    closeMenu();
    setRenaming(true);
  };

  const handleNewPlutoNotebook = () => {
    closeMenu();
    setExpanded(true);
    setPlutoPromptMode(true);
  };

  const handlePlutoPromptConfirm = async (name: string) => {
    setPlutoPromptMode(false);
    const fileName = name.endsWith(".jl") ? name : `${name}.jl`;
    const dir = node.is_dir ? node.path : node.path.replace(/[^/\\]+$/, "");
    const sep = dir.endsWith("/") || dir.endsWith("\\") ? "" : "/";
    const newPath = `${dir}${sep}${fileName}`;
    try {
      await invoke("fs_create_file", { path: newPath });
      onRefresh();
      useIdeStore.getState().setPlutoNotebookPath(newPath);
      const workspacePath = useIdeStore.getState().workspacePath;
      const plutoPort = useSettingsStore.getState().settings.plutoPort;
      await invoke("pluto_open", {
        notebookPath: newPath,
        workspacePath: workspacePath ?? null,
        port: plutoPort,
      });
    } catch (e) {
      console.error("Failed to create Pluto notebook:", e);
    }
  };

  const commitRename = async () => {
    setRenaming(false);
    if (newName === node.name || !newName.trim()) return;
    const dir = node.path.replace(/[^/\\]+$/, "");
    const newPath = `${dir}${newName.trim()}`;
    try {
      await invoke("fs_rename", { oldPath: node.path, newPath });
      onRefresh();
    } catch (e) {
      console.error("Rename failed:", e);
      setNewName(node.name);
    }
  };

  const handlePromptConfirm = async (name: string) => {
    setPromptMode(null);
    const dir = node.is_dir ? node.path : node.path.replace(/[^/\\]+$/, "");
    const sep = dir.endsWith("/") || dir.endsWith("\\") ? "" : "/";
    const newPath = `${dir}${sep}${name}`;
    try {
      if (promptMode === "file") {
        await invoke("fs_create_file", { path: newPath });
      } else {
        await invoke("fs_create_dir", { path: newPath });
      }
      onRefresh();
    } catch (e) {
      console.error("Create failed:", e);
    }
  };

  const indentPx = depth * 12 + 8;

  return (
    <>
      <div
        className={`file-tree-node ${dragOver ? "drag-over" : ""}`}
        style={{ paddingLeft: indentPx }}
        draggable={!renaming}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", node.path);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => {
          if (node.is_dir) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={async (e) => {
          e.preventDefault();
          setDragOver(false);
          if (!node.is_dir) return;
          const sourcePath = e.dataTransfer.getData("text/plain");
          if (!sourcePath || sourcePath === node.path) return;
          const fileName = sourcePath.split(/[/\\]/).pop();
          const sep = node.path.endsWith("/") ? "" : "/";
          const newPath = `${node.path}${sep}${fileName}`;
          try {
            await invoke("fs_rename", { oldPath: sourcePath, newPath });
            onRefresh();
          } catch (err) {
            console.error("Move failed:", err);
          }
        }}
      >
        <span className="file-tree-chevron">
          {node.is_dir ? expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}
        </span>
        <span className="file-tree-icon">
          {node.is_dir ? (
            expanded ? (
              <FolderOpen size={14} className="folder-icon" />
            ) : (
              <Folder size={14} className="folder-icon" />
            )
          ) : (
            getFileIcon(node.name)
          )}
        </span>
        {renaming ? (
          <input
            className="file-tree-rename-input"
            value={newName}
            autoFocus
            onChange={(e) => setNewName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") {
                setRenaming(false);
                setNewName(node.name);
              }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="file-tree-name">{node.name}</span>
        )}
      </div>

      {/* Inline prompt for new file/folder */}
      {promptMode && (
        <div style={{ paddingLeft: indentPx + 24 }}>
          <InlinePrompt
            placeholder={promptMode === "file" ? "filename.jl" : "folder name"}
            onConfirm={handlePromptConfirm}
            onCancel={() => setPromptMode(null)}
          />
        </div>
      )}
      {plutoPromptMode && (
        <div style={{ paddingLeft: indentPx + 24 }}>
          <InlinePrompt
            placeholder="notebook.jl"
            onConfirm={handlePlutoPromptConfirm}
            onCancel={() => setPlutoPromptMode(false)}
          />
        </div>
      )}

      {node.is_dir &&
        expanded &&
        node.children?.map((child) => (
          <FileTreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            onOpen={onOpen}
            onRefresh={onRefresh}
          />
        ))}

      {contextMenu && (
        <>
          <div className="context-menu-overlay" onClick={closeMenu} />
          <div className="context-menu" style={{ top: contextMenu.y, left: contextMenu.x }}>
            {node.is_dir && (
              <>
                <button onClick={handleNewFile}>
                  <FilePlus size={13} /> New File
                </button>
                <button onClick={handleNewFolder}>
                  <FolderPlus size={13} /> New Folder
                </button>
                <button onClick={handleNewPlutoNotebook}>
                  <BookOpen size={13} /> New Pluto Notebook
                </button>
                <div className="context-menu-separator" />
              </>
            )}
            <button onClick={handleRename}>
              <Edit2 size={13} /> Rename
            </button>
            <button onClick={handleDelete} className="danger">
              <Trash2 size={13} /> Delete
            </button>
            {!node.is_dir && node.name.endsWith(".jl") && (
              <>
                <div className="context-menu-separator" />
                <button onClick={handleOpenAsPluto}>
                  <BookOpen size={13} /> Open as Pluto Notebook
                </button>
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}

export function FileExplorer() {
  const workspacePath = useIdeStore((s) => s.workspacePath);
  const fileTree = useIdeStore((s) => s.fileTree);
  const setWorkspace = useIdeStore((s) => s.setWorkspace);
  const setFileTree = useIdeStore((s) => s.setFileTree);

  // Root-level new file/folder prompts
  const [rootPrompt, setRootPrompt] = useState<"file" | "folder" | null>(null);

  const openFolder = async () => {
    try {
      const path = await invoke<string | null>("dialog_open_folder");
      if (!path) return;
      const tree = await invoke<FileNode>("fs_get_tree", { path });
      setWorkspace(path, tree);
    } catch (e) {
      console.error("Failed to open folder:", e);
    }
  };

  const refreshTree = useCallback(async () => {
    if (!workspacePath) return;
    try {
      const tree = await invoke<FileNode>("fs_get_tree", { path: workspacePath });
      setFileTree(tree);
    } catch (e) {
      console.error("Refresh failed:", e);
    }
  }, [workspacePath, setFileTree]);

  const handleOpen = useCallback(async (node: FileNode) => {
    if (node.is_dir) return;
    const existingTabs = useIdeStore.getState().openTabs;
    const existing = existingTabs.find((t) => t.path === node.path);
    if (existing) {
      useIdeStore.getState().setActiveTab(existing.id);
      return;
    }
    try {
      // Delegated rather than duplicated: openFileAtPath is the single place that
      // intercepts `.ipynb` and registers a jupytext pairing, and it also gives every
      // tab the same `id: path` convention this used to diverge from.
      await openFileAtPath(node.path, node.name);
    } catch (e) {
      console.error("Cannot open file:", e);
    }
  }, []);

  const handleRootPromptConfirm = async (name: string) => {
    if (!workspacePath) return;
    setRootPrompt(null);
    const sep = workspacePath.endsWith("/") || workspacePath.endsWith("\\") ? "" : "/";
    const newPath = `${workspacePath}${sep}${name}`;
    try {
      if (rootPrompt === "file") {
        await invoke("fs_create_file", { path: newPath });
      } else {
        await invoke("fs_create_dir", { path: newPath });
      }
      refreshTree();
    } catch (e) {
      console.error("Create failed:", e);
    }
  };

  return (
    <div className="file-explorer">
      <div className="file-explorer-header">
        <span className="file-explorer-title">
          {workspacePath ? workspacePath.split(/[/\\]/).pop()?.toUpperCase() : "EXPLORER"}
        </span>
        <div className="file-explorer-actions">
          {workspacePath && (
            <>
              <button title="New File" aria-label="New File" onClick={() => setRootPrompt("file")}>
                <FilePlus size={14} />
              </button>
              <button
                title="New Folder"
                aria-label="New Folder"
                onClick={() => setRootPrompt("folder")}
              >
                <FolderPlus size={14} />
              </button>
              <button title="Refresh" aria-label="Refresh" onClick={refreshTree}>
                <RefreshCw size={14} />
              </button>
            </>
          )}
        </div>
      </div>

      <div className="file-explorer-tree">
        {!workspacePath ? (
          <div className="file-explorer-empty">
            <p>No folder open</p>
            <button className="btn-primary" onClick={openFolder}>
              Open Folder
            </button>
          </div>
        ) : (
          <>
            {rootPrompt && (
              <div style={{ padding: "2px 8px" }}>
                <InlinePrompt
                  placeholder={rootPrompt === "file" ? "filename.jl" : "folder name"}
                  onConfirm={handleRootPromptConfirm}
                  onCancel={() => setRootPrompt(null)}
                />
              </div>
            )}
            {fileTree?.children?.map((child) => (
              <FileTreeNode
                key={child.path}
                node={child}
                depth={0}
                onOpen={handleOpen}
                onRefresh={refreshTree}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
