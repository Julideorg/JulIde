// src/components/Editor/MonacoEditor.tsx
import { useEffect, useRef, useCallback, useState } from "react";
import Editor, { OnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";
import { useIdeStore } from "../../stores/useIdeStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { LATEX_UNICODE } from "./latexUnicode";
import { lspClient } from "../../lsp/LspClient";
import { pathToUri } from "../../lsp/uri";
import { PTY_SESSION_ID } from "../../constants";
import { cellResultDecorations, getActiveTab, runCellAtCursor } from "./runCell";
import { isNotebookSource, parseJupytext } from "../../notebook/jupytext";
import { useCellLayer } from "./notebook/useCellLayer";
import { setActiveCellLayer } from "./notebook/cellLens";
import { runCell, runCellAndAdvance } from "./notebook/cellActions";
import { syncToNotebook } from "../../notebook/pairing";
import { toast } from "../ui";
import { toAscii } from "../../services/ascii";

const SAVE_DEBOUNCE_MS = 800;
const DEFER_RENDER_MS = 200; // Time to let Monaco paint before firing heavy IPC/Scans

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
  const debug = useIdeStore((s) => s.debug);
  const problems = useIdeStore((s) => s.problems);
  const blameEnabled = useIdeStore((s) => s.blameEnabled);
  const workspacePath = useIdeStore((s) => s.workspacePath);

  const setEditorInstance = useIdeStore((s) => s.setEditorInstance);
  const setCursorPosition = useIdeStore((s) => s.setCursorPosition);
  const settings = useSettingsStore((s) => s.settings);

  const activeTab = openTabs.find((t) => t.id === activeTabId) ?? null;
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  // State as well as a ref: the cell layer is a hook, so it needs a render to attach.
  const [mountedEditor, setMountedEditor] = useState<Monaco.editor.IStandaloneCodeEditor | null>(
    null,
  );
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
  const cellLayerRef = useRef<import("./notebook/cellZones").NotebookCellLayer | null>(null);
  const notebookContextRef = useRef<Monaco.editor.IContextKey<boolean> | null>(null);

  const updateCellDecorations = useCallback(() => {
    const editor = editorRef.current;
    if (!editor || !cellDecoRef.current) return;
    // Read the path from the store: this runs from a setTimeout in handleMount, which
    // captured the mount-time closure.
    if (!getActiveTab()?.path.endsWith(".jl")) return;

    const model = editor.getModel();
    if (!model) return;

    // One parse drives the decorations and Ctrl+Enter alike, so they cannot disagree
    // about where a cell ends. It also understands `# %%`, which the previous
    // `startsWith("##")` scan did not — a percent notebook read as one giant cell.
    const doc = parseJupytext(model.getValue());
    const decos: Monaco.editor.IModelDeltaDecoration[] = doc.cells
      .filter((cell) => !cell.implicit)
      .map((cell) => ({
        range: {
          startLineNumber: cell.range.markerLine,
          startColumn: 1,
          endLineNumber: cell.range.markerLine,
          endColumn: 1,
        },
        options: {
          isWholeLine: true,
          className: "code-cell-separator",
          glyphMarginClassName: "code-cell-glyph",
        },
      }));
    cellDecoRef.current.set(decos);
  }, []);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    setEditorInstance(editor);
    setMountedEditor(editor);

    editor.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = e.target.position?.lineNumber;
      const tab = getActiveTab();
      if (line && tab) {
        useIdeStore.getState().toggleBreakpoint(tab.path, line);
      }
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveActiveTab(editor);
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

    // Notebook files run through the persistent kernel so cells share state; a plain
    // `##` script keeps the old one-shot path, which needs no kernel at all.
    const layerNow = () => cellLayerRef.current;
    editor.addAction({
      id: "julide.notebook.runCell",
      label: "Run Cell",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      contextMenuGroupId: "julide-notebook",
      contextMenuOrder: 1,
      run: () => {
        const layer = layerNow();
        const tab = getActiveTab();
        if (layer && tab && isNotebookSource(tab.content)) void runCell(editor, layer);
        else void runCellAtCursor(editor);
      },
    });
    editor.addAction({
      id: "julide.notebook.runCellAndAdvance",
      label: "Run Cell and Advance",
      keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.Enter],
      precondition: "julideNotebookFile",
      contextMenuGroupId: "julide-notebook",
      contextMenuOrder: 2,
      run: () => {
        const layer = layerNow();
        if (layer) void runCellAndAdvance(editor, layer);
      },
    });
    notebookContextRef.current = editor.createContextKey<boolean>("julideNotebookFile", false);

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
    cellResultDecorations.set(editor, cellResultDecoRef.current);
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

  /**
   * Save the tab that is active *now*, formatting first if the user asked for it.
   *
   * Bound only to the explicit Ctrl+S path. Autosave writes on a debounce while
   * you type, and reformatting there would rearrange the buffer under the
   * cursor mid-keystroke.
   *
   * The tab is read from the store rather than taken from the render closure:
   * the editor is mounted once and reused across tabs, so a captured `activeTab`
   * would go stale as soon as you switched files.
   */
  const saveActiveTab = useCallback(
    async (editor: Monaco.editor.IStandaloneCodeEditor) => {
      const { openTabs: tabs, activeTabId: id } = useIdeStore.getState();
      const tab = tabs.find((t) => t.id === id);
      if (!tab) return;

      const shouldFormat =
        useSettingsStore.getState().settings.formatOnSave &&
        tab.path.endsWith(".jl") &&
        lspClient.supports("documentFormattingProvider");
      if (shouldFormat) {
        try {
          await editor.getAction("editor.action.formatDocument")?.run();
        } catch (e) {
          // A formatter failure must not cost the user their save.
          console.error("Format on save failed:", e);
        }
      }
      const text = editor.getValue();
      await saveFile(tab.id, tab.path, text);

      // Pairing runs on the explicit save only, never on the 800ms autosave — see the
      // note at the top of notebook/pairing.ts. The two files may drift between saves
      // and reconverge here; the .ipynb is a pure projection, so nothing is lost.
      void syncToNotebook(tab.path, text, "save").then((result) => {
        if (result.status === "conflict") {
          toast.warning("The paired notebook changed on disk", result.message ?? "");
        } else if (result.status === "error") {
          toast.error("Could not update the paired notebook", result.message ?? "");
        }
      });
    },
    [saveFile],
  );

  // LSP Management
  useEffect(() => {
    if (!activeTab?.path.endsWith(".jl")) return;
    const uri = pathToUri(activeTab.path);
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
          // Monaco owns this string, so there is no JSX to hang a hook on. The glyph
          // is julIDE's; `p.message` is the language server's and stays as it came.
          content: `  ${toAscii(p.severity === "error" ? "✕" : "⚠")} ${p.message}`,
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
      updateTabContent(activeTab.id, value);

      // Autosave is a setting, and until 0.5.0 it was one nothing read — the debounce
      // below ran for everyone, which is why "unsaved" never meant anything and the tab
      // dot stayed dark. Read at schedule time rather than closed over, so turning it
      // off stops the next keystroke rather than the next remount.
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (useSettingsStore.getState().settings.autoSave) {
        saveTimerRef.current = setTimeout(() => {
          saveFile(activeTab.id, activeTab.path, value);
        }, SAVE_DEBOUNCE_MS);
      }

      if (activeTab.path.endsWith(".jl")) {
        if (lspChangeTimerRef.current) clearTimeout(lspChangeTimerRef.current);
        lspChangeTimerRef.current = setTimeout(() => {
          const uri = pathToUri(activeTab.path);
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

  // Cell output panels. Only for jupytext files: a plain script gets no view zones and
  // no anchors, so the layer costs nothing when it is not wanted.
  const isNotebook = !!activeTab?.path.endsWith(".jl") && isNotebookSource(activeTab.content);
  const { portals } = useCellLayer(mountedEditor, isNotebook, (layer) => {
    cellLayerRef.current = layer;
    // The lens commands are module-global, so they need to know which editor owns the
    // cells right now.
    setActiveCellLayer(layer ? mountedEditor : null, layer);
  });

  useEffect(() => {
    notebookContextRef.current?.set(isNotebook);
  }, [isNotebook]);

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
        // The model URI, not just a key: @monaco-editor/react builds the model
        // with `monaco.Uri.parse(path)`. Handing it the raw OS path made the
        // model's URI something the language server had never seen (on Windows,
        // a `C:` scheme), so diagnostics arrived for a URI with no model behind
        // it and no squiggle was ever drawn.
        path={pathToUri(activeTab.path)}
        language={getLanguage(activeTab.name)}
        defaultValue={activeTab.content}
        theme={settings.theme}
        onMount={handleMount}
        onChange={handleChange}
        options={{
          fontSize: settings.fontSize,
          fontFamily: settings.fontFamily,
          // ASCII mode drops only `liga`/`calt` — the JetBrains Mono programming
          // ligatures that draw `!=` as `≠` and `->` as `→` while the file on disk
          // stays plain ASCII. `ccmp`/`mark`/`mkmk` stay on in both modes: they are
          // what composes Julia's combining marks (`\bar`+Tab inserts U+0304), and
          // they were added deliberately to fix issue 8. Spelling the features out
          // rather than passing `false` matters — Monaco maps `false` to a fixed
          // `"liga" off, "calt" off`, which drops those three guarantees silently.
          fontLigatures: settings.asciiOnly
            ? "'calt' off, 'ccmp' on, 'liga' off, 'mark' on, 'mkmk' on"
            : "'calt' on, 'ccmp' on, 'liga' on, 'mark' on, 'mkmk' on",
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
      {/*
        Cell outputs. Rendered here as portals into Monaco-owned view-zone nodes, so the
        panels participate in the React tree while Monaco keeps control of their layout.
      */}
      {portals}
    </div>
  );
}
