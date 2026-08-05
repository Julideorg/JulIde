// src/components/Editor/MonacoEditor.tsx
import { useEffect, useRef, useCallback } from "react";
import Editor, { OnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useIdeStore } from "../../stores/useIdeStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { LATEX_UNICODE } from "./latexUnicode";
import { lspClient } from "../../lsp/LspClient";
import { PTY_SESSION_ID } from "../../constants";
import type { JuliaOutputEvent } from "../../types";
import { stripAnsiForDisplay } from "../../utils/juliaOutput";

const SAVE_DEBOUNCE_MS = 800;
const DEFER_RENDER_MS = 200; // Time to let Monaco paint before firing heavy IPC/Scans

function getCellRange(
  model: Monaco.editor.ITextModel,
  lineNumber: number,
): { startLine: number; endLine: number } {
  const lineCount = model.getLineCount();
  let startLine = 1;
  let endLine = lineCount;

  for (let i = lineNumber; i >= 1; i--) {
    const content = model.getLineContent(i).trimStart();
    if (content.startsWith("##")) {
      startLine = i === lineNumber ? i + 1 : i + 1;
      break;
    }
  }

  const currentContent = model.getLineContent(lineNumber).trimStart();
  if (currentContent.startsWith("##")) {
    startLine = lineNumber + 1;
  }

  for (let i = startLine; i <= lineCount; i++) {
    const content = model.getLineContent(i).trimStart();
    if (content.startsWith("##") && i > startLine) {
      endLine = i - 1;
      break;
    }
  }

  return { startLine, endLine };
}

function getLanguage(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jl":
      return "julia";
    case "json":
      return "json";
    case "toml":
      return "toml";
    case "md":
      return "markdown";
    case "ts":
    case "tsx":
      return "typescript";
    case "js":
    case "jsx":
      return "javascript";
    case "py":
      return "python";
    case "rs":
      return "rust";
    default:
      return "plaintext";
  }
}

export function MonacoEditor() {
  const activeTabId = useIdeStore((s) => s.activeTabId);
  const openTabs = useIdeStore((s) => s.openTabs);
  const updateTabContent = useIdeStore((s) => s.updateTabContent);
  const markTabSaved = useIdeStore((s) => s.markTabSaved);
  const breakpoints = useIdeStore((s) => s.breakpoints);
  const toggleBreakpoint = useIdeStore((s) => s.toggleBreakpoint);
  const debug = useIdeStore((s) => s.debug);
  const problems = useIdeStore((s) => s.problems);
  const blameEnabled = useIdeStore((s) => s.blameEnabled);
  const workspacePath = useIdeStore((s) => s.workspacePath);

  const setEditorInstance = useIdeStore((s) => s.setEditorInstance);
  const setCursorPosition = useIdeStore((s) => s.setCursorPosition);
  const settings = useSettingsStore((s) => s.settings);

  const activeTab = openTabs.find((t) => t.id === activeTabId) ?? null;
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lspChangeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cellUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lspVersionRef = useRef<Map<string, number>>(new Map());

  const decorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const debugDecoRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const cellDecoRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const cellResultDecoRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const errorLensDecoRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const blameDecoRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const updateCellDecorations = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || !cellDecoRef.current || !activeTab?.path.endsWith(".jl")) return;

    const model = editor.getModel();
    if (!model) return;

    const decos: Monaco.editor.IModelDeltaDecoration[] = [];
    const lineCount = model.getLineCount();

    for (let i = 1; i <= lineCount; i++) {
      const content = model.getLineContent(i).trimStart();
      if (content.startsWith("##")) {
        decos.push({
          range: { startLineNumber: i, startColumn: 1, endLineNumber: i, endColumn: 1 },
          options: {
            isWholeLine: true,
            className: "code-cell-separator",
            glyphMarginClassName: "code-cell-glyph",
          },
        });
      }
    }
    cellDecoRef.current.set(decos);
  }, [activeTab?.path]);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    setEditorInstance(editor);

    editor.onMouseDown((e) => {
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
        const line = e.target.position?.lineNumber;
        if (line && activeTab) {
          toggleBreakpoint(activeTab.path, line);
        }
      }
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (activeTab) {
        saveFile(activeTab.id, activeTab.path, editor.getValue());
      }
    });

    editor.onKeyDown((e) => {
      if (e.keyCode !== monaco.KeyCode.Tab) return;
      const model = editor.getModel();
      const position = editor.getPosition();
      if (!model || !position) return;
      const textBefore = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const match = textBefore.match(/\\[^\s\\]*$/);
      if (!match) return;
      const latex = match[0];
      const unicode = LATEX_UNICODE[latex];
      if (!unicode) return;
      e.preventDefault();
      e.stopPropagation();
      editor.executeEdits("latex-completion", [
        {
          range: {
            startLineNumber: position.lineNumber,
            startColumn: position.column - latex.length,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          },
          text: unicode,
        },
      ]);
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      const model = editor.getModel();
      const position = editor.getPosition();
      if (!model || !position || !activeTab?.path.endsWith(".jl")) return;

      const { startLine, endLine } = getCellRange(model, position.lineNumber);
      const lines: string[] = [];
      for (let i = startLine; i <= endLine; i++) {
        lines.push(model.getLineContent(i));
      }
      const code = lines.join("\n").trim();
      if (!code) return;

      if (cellResultDecoRef.current) {
        cellResultDecoRef.current.set([
          {
            range: {
              startLineNumber: endLine,
              startColumn: 1,
              endLineNumber: endLine,
              endColumn: 1,
            },
            options: {
              isWholeLine: true,
              after: { content: "  ... running", inlineClassName: "cell-result-running" },
            },
          },
        ]);
      }

      const outputLines: string[] = [];
      let resultUnlisten: (() => void) | null = null;

      listen<JuliaOutputEvent>("julia-output", (event) => {
        const { kind, text } = event.payload;
        if (kind === "stdout" || kind === "stderr") {
          if (text) outputLines.push(text);
        } else if (kind === "done") {
          const resultText =
            stripAnsiForDisplay(outputLines.join("; ").slice(0, 120)).trim() || "(no output)";
          if (cellResultDecoRef.current) {
            cellResultDecoRef.current.set([
              {
                range: {
                  startLineNumber: endLine,
                  startColumn: 1,
                  endLineNumber: endLine,
                  endColumn: 1,
                },
                options: {
                  isWholeLine: true,
                  after: { content: `  => ${resultText}`, inlineClassName: "cell-result-text" },
                },
              },
            ]);
          }
          const store = useIdeStore.getState();
          store.setIsRunning(false);
          resultUnlisten?.();
        }
      }).then((fn) => {
        resultUnlisten = fn;
      });

      const store = useIdeStore.getState();
      store.setIsRunning(true);
      store.appendOutput({ kind: "info", text: `Cell [Ln ${startLine}-${endLine}]` });
      invoke("julia_eval", {
        code,
        projectPath: store.workspacePath ?? null,
      }).catch((e) => {
        store.appendOutput({ kind: "stderr", text: String(e) });
        store.setIsRunning(false);
        if (cellResultDecoRef.current) {
          cellResultDecoRef.current.set([
            {
              range: {
                startLineNumber: endLine,
                startColumn: 1,
                endLineNumber: endLine,
                endColumn: 1,
              },
              options: {
                isWholeLine: true,
                after: {
                  content: `  => Error: ${String(e).slice(0, 80)}`,
                  inlineClassName: "cell-result-error",
                },
              },
            },
          ]);
        }
      });
    });

    editor.onDidChangeCursorPosition((e) => {
      setCursorPosition(e.position.lineNumber, e.position.column);
    });

    if (containerRef.current) {
      const observer = new ResizeObserver(() => editor.layout());
      observer.observe(containerRef.current);
    }

    decorationsRef.current = editor.createDecorationsCollection([]);
    debugDecoRef.current = editor.createDecorationsCollection([]);
    cellDecoRef.current = editor.createDecorationsCollection([]);
    cellResultDecoRef.current = editor.createDecorationsCollection([]);
    errorLensDecoRef.current = editor.createDecorationsCollection([]);
    blameDecoRef.current = editor.createDecorationsCollection([]);

    // PERFORMANCE: Avoid synchronous heavy scanning immediately inside handleMount
    setTimeout(() => {
      updateCellDecorations();
    }, DEFER_RENDER_MS);
  };

  const saveFile = useCallback(
    async (tabId: string, path: string, content: string) => {
      try {
        await invoke("fs_write_file", { path, content });
        markTabSaved(tabId);
        if (useIdeStore.getState().reviseEnabled && path.endsWith(".jl")) {
          invoke("pty_write", {
            sessionId: PTY_SESSION_ID,
            data: "Revise.revise()\n",
          }).catch(console.error);
        }
      } catch (e) {
        console.error("Save failed:", e);
      }
    },
    [markTabSaved],
  );

  // LSP Management
  useEffect(() => {
    if (!activeTab?.path.endsWith(".jl")) return;
    const uri = `file://${activeTab.path}`;
    lspVersionRef.current.set(uri, 1);
    lspClient.didOpen(uri, activeTab.content).catch(console.error);
    return () => {
      lspClient.didClose(uri).catch(console.error);
    };
  }, [activeTab?.path]);

  // Breakpoints
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !decorationsRef.current || !activeTab) return;

    const fileBreakpoints = breakpoints.filter((b) => b.file === activeTab.path);
    const decorations: Monaco.editor.IModelDeltaDecoration[] = fileBreakpoints.map((bp) => ({
      range: { startLineNumber: bp.line, startColumn: 1, endLineNumber: bp.line, endColumn: 1 },
      options: {
        isWholeLine: false,
        glyphMarginClassName: "breakpoint-glyph",
        glyphMarginHoverMessage: { value: "Breakpoint" },
      },
    }));
    decorationsRef.current.set(decorations);
  }, [breakpoints, activeTab?.path]);

  // Problems / Diagnostics
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !errorLensDecoRef.current || !activeTab) return;

    const fileProblems = problems.filter((p) => p.file === activeTab.path);
    const decos: Monaco.editor.IModelDeltaDecoration[] = fileProblems.map((p) => ({
      range: { startLineNumber: p.line, startColumn: 1, endLineNumber: p.line, endColumn: 1 },
      options: {
        isWholeLine: true,
        after: {
          content: `  ${p.severity === "error" ? "✕" : "⚠"} ${p.message}`,
          inlineClassName: `error-lens error-lens-${p.severity}`,
        },
      },
    }));
    errorLensDecoRef.current.set(decos);
  }, [problems, activeTab?.path]);

  // Debug line highlight
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !debugDecoRef.current) return;

    if (debug.isPaused && debug.currentLine > 0) {
      debugDecoRef.current.set([
        {
          range: {
            startLineNumber: debug.currentLine,
            startColumn: 1,
            endLineNumber: debug.currentLine,
            endColumn: 1,
          },
          options: {
            isWholeLine: true,
            className: "debug-current-line",
            glyphMarginClassName: "debug Arrow-glyph",
          },
        },
      ]);
    } else {
      debugDecoRef.current.set([]);
    }
  }, [debug.isPaused, debug.currentLine]);

  // PERFORMANCE FIX: Debounce Git Blame IPC
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !blameDecoRef.current || !activeTab || !blameEnabled || !workspacePath) {
      blameDecoRef.current?.set([]);
      return;
    }

    let isCurrent = true;
    let relativePath = activeTab.path;
    if (relativePath.startsWith(workspacePath)) {
      relativePath = relativePath.slice(workspacePath.length + 1);
    }

    // Delay git blame invocation to ensure Monaco handles the file layout transition smoothly
    const blameTimeout = setTimeout(() => {
      invoke<
        Array<{ line: number; author: string; date: string; commitId: string; summary: string }>
      >("git_blame_file", { workspacePath, filePath: relativePath })
        .then((blameLines) => {
          if (!isCurrent || !blameDecoRef.current) return;
          const decos: Monaco.editor.IModelDeltaDecoration[] = blameLines.map((b) => ({
            range: { startLineNumber: b.line, startColumn: 1, endLineNumber: b.line, endColumn: 1 },
            options: {
              isWholeLine: true,
              after: {
                content: `  ${b.author}, ${b.date} - ${b.summary.slice(0, 40)}`,
                inlineClassName: "git-blame-text",
              },
            },
          }));
          blameDecoRef.current.set(decos);
        })
        .catch(() => {
          if (isCurrent) blameDecoRef.current?.set([]);
        });
    }, DEFER_RENDER_MS);

    return () => {
      isCurrent = false;
      clearTimeout(blameTimeout);
    };
  }, [blameEnabled, activeTab?.path, workspacePath]);

  // PERFORMANCE FIX: Defer Julia cell separator collection scans
  useEffect(() => {
    if (!activeTab?.path.endsWith(".jl")) {
      cellDecoRef.current?.set([]);
      return;
    }

    const cellTimeout = setTimeout(() => {
      updateCellDecorations();
    }, DEFER_RENDER_MS);

    cellResultDecoRef.current?.set([]);

    return () => clearTimeout(cellTimeout);
  }, [activeTab?.path, updateCellDecorations]);

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (!activeTab || value === undefined) return;
      updateTabContent(activeTab.id, value, false);

      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        saveFile(activeTab.id, activeTab.path, value);
      }, SAVE_DEBOUNCE_MS);

      if (activeTab.path.endsWith(".jl")) {
        if (lspChangeTimerRef.current) clearTimeout(lspChangeTimerRef.current);
        lspChangeTimerRef.current = setTimeout(() => {
          const uri = `file://${activeTab.path}`;
          const v = (lspVersionRef.current.get(uri) ?? 1) + 1;
          lspVersionRef.current.set(uri, v);
          lspClient.didChange(uri, value, v).catch(console.error);
        }, 300);

        if (cellUpdateTimerRef.current) clearTimeout(cellUpdateTimerRef.current);
        cellUpdateTimerRef.current = setTimeout(() => {
          updateCellDecorations();
        }, 500);
      }
    },
    [activeTab, updateTabContent, saveFile, updateCellDecorations],
  );

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (lspChangeTimerRef.current) clearTimeout(lspChangeTimerRef.current);
      if (cellUpdateTimerRef.current) clearTimeout(cellUpdateTimerRef.current);
    };
  }, []);

  if (!activeTab) {
    return (
      <div className="editor-empty">
        <div className="editor-empty-content">
          <div className="editor-empty-icon">
            <svg
              width="64"
              height="64"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
          </div>
          <p>
            Open a file from the explorer or use <kbd>Cmd+O</kbd>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="editor-container">
      <Editor
        path={activeTab.path}
        language={getLanguage(activeTab.name)}
        defaultValue={activeTab.content}
        theme={settings.theme}
        onMount={handleMount}
        onChange={handleChange}
        options={{
          fontSize: settings.fontSize,
          fontFamily: settings.fontFamily,
          fontLigatures: "'calt' on, 'ccmp' on, 'liga' on, 'mark' on, 'mkmk' on",
          disableMonospaceOptimizations: true,
          lineNumbers: "on",
          minimap: { enabled: settings.minimapEnabled, scale: 1 },
          scrollBeyondLastLine: false,
          automaticLayout: false, // Critical performance helper (good you had this off!)
          tabSize: settings.tabSize,
          insertSpaces: true,
          wordWrap: settings.wordWrap as "off" | "on" | "wordWrapColumn" | "bounded",
          glyphMargin: true,
          folding: true,
          renderLineHighlight: "all",
          cursorBlinking: "smooth",
          smoothScrolling: true,
          bracketPairColorization: { enabled: true },
          guides: { bracketPairs: true, indentation: true },
          stickyScroll: { enabled: true },
          unicodeHighlight: {
            ambiguousCharacters: false,
            invisibleCharacters: false,
            nonBasicASCII: false,
          },
          padding: { top: 8, bottom: 8 },
        }}
      />
    </div>
  );
}
