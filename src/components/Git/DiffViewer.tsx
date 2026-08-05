import { useState, useEffect } from "react";
import { DiffEditor, type BeforeMount } from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import { useIdeStore } from "../../stores/useIdeStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { themes } from "../../themes/themes";
import { registerJuliaLanguage } from "../Editor/juliaLanguage";

interface DiffViewerProps {
  filePath: string;
  fileStatus: string;
  onClose: () => void;
}

export function DiffViewer({ filePath, fileStatus, onClose }: DiffViewerProps) {
  const workspacePath = useIdeStore((s) => s.workspacePath);
  const settings = useSettingsStore((s) => s.settings);

  const [original, setOriginal] = useState<string>("");
  const [modified, setModified] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!workspacePath) return;

    setLoading(true);
    const fullPath = `${workspacePath}/${filePath}`;

    Promise.all([
      // Get HEAD version (original)
      fileStatus === "untracked" || fileStatus === "added"
        ? Promise.resolve("")
        : invoke<string>("git_show_file_at_head", { workspacePath, filePath }).catch(() => ""),
      // Get working copy (modified)
      fileStatus === "deleted"
        ? Promise.resolve("")
        : invoke<string>("fs_read_file", { path: fullPath }).catch(() => ""),
    ]).then(([orig, mod]) => {
      setOriginal(orig);
      setModified(mod);
      setLoading(false);
    });
  }, [workspacePath, filePath, fileStatus]);

  const handleBeforeMount: BeforeMount = (monaco) => {
    registerJuliaLanguage(monaco);
    for (const [id, theme] of Object.entries(themes)) {
      monaco.editor.defineTheme(id, theme.monacoTheme);
    }
  };

  const ext = filePath.split(".").pop()?.toLowerCase();
  const language =
    ext === "jl"
      ? "julia"
      : ext === "toml"
        ? "toml"
        : ext === "json"
          ? "json"
          : ext === "md"
            ? "markdown"
            : "plaintext";

  return (
    <div className="diff-viewer">
      <div className="diff-viewer-header">
        <span className="diff-viewer-title">
          {filePath}
          <span className={`diff-viewer-status ${fileStatus}`}>
            {fileStatus === "modified"
              ? "M"
              : fileStatus === "added"
                ? "A"
                : fileStatus === "deleted"
                  ? "D"
                  : fileStatus[0]?.toUpperCase()}
          </span>
        </span>
        <button
          className="diff-viewer-close"
          onClick={onClose}
          title="Close diff"
          aria-label="Close diff"
        >
          <X size={14} />
        </button>
      </div>
      <div className="diff-viewer-editor">
        {loading ? (
          <div className="diff-viewer-loading">Loading diff...</div>
        ) : (
          <DiffEditor
            original={original}
            modified={modified}
            language={language}
            theme={settings.theme}
            beforeMount={handleBeforeMount}
            options={{
              readOnly: true,
              fontSize: settings.fontSize,
              fontFamily: settings.fontFamily,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              renderSideBySide: true,
              originalEditable: false,
              glyphMargin: false,
              lineNumbers: "on",
            }}
          />
        )}
      </div>
    </div>
  );
}
