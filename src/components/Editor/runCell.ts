// src/components/Editor/runCell.ts
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type * as Monaco from "monaco-editor";
import { useIdeStore } from "../../stores/useIdeStore";
import { cellRangeAtLine, parseJupytext } from "../../notebook/jupytext";
import type { JuliaOutputEvent } from "../../types";
import { stripAnsiForDisplay } from "../../utils/juliaOutput";

/**
 * Running the code cell under the cursor.
 *
 * Split out of MonacoEditor so the command palette can reach it: everything here needs
 * only `import type` from monaco-editor, so importing this module does not drag the
 * editor bundle in behind it.
 */

const MAX_INLINE_RESULT = 120;

/**
 * The body lines of the cell containing `lineNumber`, 1-based inclusive.
 *
 * Delegates to the jupytext parser, which understands `# %%` as well as julIDE's older
 * `##` separator and — unlike the hand-rolled scan this replaced — knows about Julia
 * strings and block comments, so a `## Examples` heading inside a docstring no longer
 * cuts a cell in half.
 */
export function getCellRange(
  model: Monaco.editor.ITextModel,
  lineNumber: number,
): { startLine: number; endLine: number } {
  return cellRangeAtLine(parseJupytext(model.getValue()), lineNumber);
}

/**
 * The tab that is active *now*.
 *
 * `handleMount` runs exactly once and `<Editor path={…}>` swaps models rather than
 * remounting, so anything a mount-time handler captures from the render closure goes
 * stale the moment you switch files. `saveActiveTab` documents the same hazard.
 */
export function getActiveTab() {
  const { openTabs, activeTabId } = useIdeStore.getState();
  return openTabs.find((t) => t.id === activeTabId) ?? null;
}

type CellRun = {
  decorations: Monaco.editor.IEditorDecorationsCollection | null;
  endLine: number;
  output: string[];
};

/**
 * Cell results arrive on one app-wide `julia-output` listener.
 *
 * Registering one per run leaked: it was only torn down inside the `done` branch, so a
 * run that errored or was killed left it attached forever — and every survivor then saw
 * every later run's output too, appending each run's lines to a dead cell's result.
 */
let cellRunListener: Promise<UnlistenFn> | null = null;
let activeCellRun: CellRun | null = null;

/**
 * Where each editor draws its inline cell result.
 *
 * Module-scoped rather than passed in, so the command-palette entry can run a cell with
 * nothing but the editor handle off `useIdeStore.editorInstance`. Weak so a disposed
 * editor's collection goes with it.
 */
export const cellResultDecorations = new WeakMap<
  Monaco.editor.IStandaloneCodeEditor,
  Monaco.editor.IEditorDecorationsCollection
>();

function setCellResult(run: CellRun, content: string, inlineClassName: string) {
  run.decorations?.set([
    {
      range: {
        startLineNumber: run.endLine,
        startColumn: 1,
        endLineNumber: run.endLine,
        endColumn: 1,
      },
      options: { isWholeLine: true, after: { content, inlineClassName } },
    },
  ]);
}

function ensureCellRunListener(): Promise<UnlistenFn> {
  cellRunListener ??= listen<JuliaOutputEvent>("julia-output", (event) => {
    const run = activeCellRun;
    if (!run) return;
    const { kind, text } = event.payload;
    if (kind === "stdout" || kind === "stderr") {
      if (text) run.output.push(text);
      return;
    }
    if (kind === "done") {
      const joined = run.output.join("; ").slice(0, MAX_INLINE_RESULT);
      const summary = stripAnsiForDisplay(joined).trim() || "(no output)";
      setCellResult(run, `  => ${summary}`, "cell-result-text");
      useIdeStore.getState().setIsRunning(false);
      activeCellRun = null;
    }
  });
  return cellRunListener;
}

/** Run the cell under the cursor. Shared by the Ctrl+Enter binding and the palette command. */
export async function runCellAtCursor(editor: Monaco.editor.IStandaloneCodeEditor): Promise<void> {
  const model = editor.getModel();
  const position = editor.getPosition();
  const tab = getActiveTab();
  if (!model || !position || !tab?.path.endsWith(".jl")) return;

  const { startLine, endLine } = getCellRange(model, position.lineNumber);
  const lines: string[] = [];
  for (let i = startLine; i <= endLine; i++) lines.push(model.getLineContent(i));
  const code = lines.join("\n").trim();
  if (!code) return;

  const run: CellRun = {
    decorations: cellResultDecorations.get(editor) ?? null,
    endLine,
    output: [],
  };
  setCellResult(run, "  ... running", "cell-result-running");

  // Awaited before invoking: otherwise a fast cell can emit `done` before the listener
  // is attached, leaving the decoration stuck on "... running" forever.
  await ensureCellRunListener();
  activeCellRun = run;

  const store = useIdeStore.getState();
  store.setIsRunning(true);
  store.appendOutput({ kind: "info", text: `Cell [Ln ${startLine}-${endLine}]` });

  try {
    await invoke("julia_eval", { code, projectPath: store.workspacePath ?? null });
  } catch (e) {
    store.appendOutput({ kind: "stderr", text: String(e) });
    store.setIsRunning(false);
    setCellResult(run, `  => Error: ${String(e).slice(0, 80)}`, "cell-result-error");
    if (activeCellRun === run) activeCellRun = null;
  }
}
