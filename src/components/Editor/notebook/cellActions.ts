import type * as Monaco from "monaco-editor";
import {
  cellIndexAtLine,
  isNotebookSource,
  parseJupytext,
  serializeJupytext,
  type JupytextCell,
} from "../../../notebook/jupytext";
import { execCell, interruptSession, restartSession } from "../../../services/notebookSession";
import { releaseAllOutputs } from "../../../services/notebookBlobs";
import { useNotebookStore } from "../../../stores/useNotebookStore";
import { getActiveTab } from "../runCell";
import type { NotebookCellLayer } from "./cellZones";

/**
 * The verbs behind the cell toolbar, the command palette and the keybindings.
 *
 * All of them go through the persistent kernel, so state is shared between cells. Rust
 * owns the queue, which is why "run all" is just N enqueues rather than an await chain:
 * an error partway through drops the rest, the way Jupyter does.
 */

/** Only code cells execute; markdown and raw are documentation. */
function runnable(cell: JupytextCell): boolean {
  return cell.type === "code" && cell.source.trim().length > 0;
}

async function runOne(layer: NotebookCellLayer, cell: JupytextCell, path: string): Promise<void> {
  if (!runnable(cell)) return;
  const anchorLine = cell.implicit ? cell.range.startLine : cell.range.markerLine;
  const cellId = layer.cellIdAtLine(anchorLine);
  if (!cellId) return;
  // The body's first line, so a stack frame points at the user's real line number.
  await execCell(cellId, cell.source, path, cell.range.startLine);
}

export function isNotebookTab(): boolean {
  const tab = getActiveTab();
  return !!tab?.path.endsWith(".jl") && isNotebookSource(tab.content);
}

export async function runCell(
  editor: Monaco.editor.IStandaloneCodeEditor,
  layer: NotebookCellLayer,
  line?: number,
): Promise<void> {
  const model = editor.getModel();
  const tab = getActiveTab();
  if (!model || !tab) return;
  const at = line ?? editor.getPosition()?.lineNumber ?? 1;
  const doc = parseJupytext(model.getValue());
  const index = cellIndexAtLine(doc, at);
  if (index === -1) return;
  // Sync first, so a cell typed a moment ago already has an anchor to attach to.
  layer.sync(doc);
  await runOne(layer, doc.cells[index], tab.path);
}

export async function runCellAndAdvance(
  editor: Monaco.editor.IStandaloneCodeEditor,
  layer: NotebookCellLayer,
): Promise<void> {
  const model = editor.getModel();
  if (!model) return;
  const at = editor.getPosition()?.lineNumber ?? 1;
  const doc = parseJupytext(model.getValue());
  const index = cellIndexAtLine(doc, at);
  await runCell(editor, layer, at);

  const next = doc.cells[index + 1];
  if (next) {
    const target = next.implicit ? next.range.startLine : next.range.startLine;
    editor.setPosition({ lineNumber: Math.min(target, model.getLineCount()), column: 1 });
    editor.revealLineInCenterIfOutsideViewport(target);
  }
}

export async function runAll(
  editor: Monaco.editor.IStandaloneCodeEditor,
  layer: NotebookCellLayer,
): Promise<void> {
  await runRange(editor, layer, () => true);
}

export async function runAbove(
  editor: Monaco.editor.IStandaloneCodeEditor,
  layer: NotebookCellLayer,
): Promise<void> {
  const index = currentIndex(editor);
  await runRange(editor, layer, (_, i) => i < index);
}

export async function runBelow(
  editor: Monaco.editor.IStandaloneCodeEditor,
  layer: NotebookCellLayer,
): Promise<void> {
  const index = currentIndex(editor);
  await runRange(editor, layer, (_, i) => i >= index);
}

function currentIndex(editor: Monaco.editor.IStandaloneCodeEditor): number {
  const model = editor.getModel();
  if (!model) return 0;
  const doc = parseJupytext(model.getValue());
  return Math.max(0, cellIndexAtLine(doc, editor.getPosition()?.lineNumber ?? 1));
}

async function runRange(
  editor: Monaco.editor.IStandaloneCodeEditor,
  layer: NotebookCellLayer,
  include: (cell: JupytextCell, index: number) => boolean,
): Promise<void> {
  const model = editor.getModel();
  const tab = getActiveTab();
  if (!model || !tab) return;
  const doc = parseJupytext(model.getValue());
  layer.sync(doc);
  for (const [i, cell] of doc.cells.entries()) {
    if (!include(cell, i)) continue;
    await runOne(layer, cell, tab.path);
  }
}

/** Insert a new cell marker, as a single undoable edit. */
export function insertCell(
  editor: Monaco.editor.IStandaloneCodeEditor,
  where: "above" | "below",
  type: "code" | "markdown" = "code",
): void {
  const model = editor.getModel();
  if (!model) return;
  const at = editor.getPosition()?.lineNumber ?? 1;
  const doc = parseJupytext(model.getValue());
  const index = cellIndexAtLine(doc, at);
  const cell = doc.cells[index];

  const marker = type === "markdown" ? "# %% [markdown]" : "# %%";
  const body = type === "markdown" ? "# " : "";
  const text = `${marker}\n${body}\n\n`;

  const line =
    where === "above"
      ? cell
        ? cell.implicit
          ? cell.range.startLine
          : cell.range.markerLine
        : 1
      : cell
        ? Math.max(cell.range.endLine, cell.range.startLine) + 1
        : model.getLineCount() + 1;
  const target = Math.min(Math.max(line, 1), model.getLineCount() + 1);

  editor.pushUndoStop();
  editor.executeEdits("notebook.insert-cell", [
    {
      range: {
        startLineNumber: target,
        startColumn: 1,
        endLineNumber: target,
        endColumn: 1,
      },
      text,
    },
  ]);
  editor.pushUndoStop();
  editor.setPosition({ lineNumber: target + 1, column: body.length + 1 });
  editor.focus();
}

/**
 * Flip a cell between code and markdown.
 *
 * One contiguous range replacement, so the rest of the file is byte-identical and the
 * whole thing is a single undo step.
 */
export function changeCellType(
  editor: Monaco.editor.IStandaloneCodeEditor,
  to: "code" | "markdown" | "raw",
): void {
  const model = editor.getModel();
  if (!model) return;
  const at = editor.getPosition()?.lineNumber ?? 1;
  const doc = parseJupytext(model.getValue());
  const index = cellIndexAtLine(doc, at);
  const cell = doc.cells[index];
  if (!cell || cell.type === to) return;

  // The span to replace is computed from the cell as parsed, before any mutation —
  // `implicit` is about to change and it decides where the cell starts.
  const from = cell.implicit ? cell.range.startLine : cell.range.markerLine;
  const until = Math.min(Math.max(cell.range.endLine, from), model.getLineCount());

  cell.type = to;
  cell.regionName = undefined;
  cell.dirty = true;
  // An implicit cell has no marker to retype, so changing its type gives it one.
  cell.implicit = false;

  // Serialized alone, so only this cell's lines are rewritten and the rest of the file
  // is byte-identical. `endsWithNewline: false` because the replacement range already
  // stops at the end of the cell's last line.
  const replacement = serializeJupytext({
    ...doc,
    header: null,
    cells: [cell],
    endsWithNewline: false,
  });

  editor.pushUndoStop();
  editor.executeEdits("notebook.change-cell-type", [
    {
      range: {
        startLineNumber: from,
        startColumn: 1,
        endLineNumber: until,
        endColumn: model.getLineMaxColumn(until),
      },
      text: replacement,
    },
  ]);
  editor.pushUndoStop();
}

export async function interrupt(): Promise<boolean> {
  return interruptSession();
}

export async function restart(): Promise<void> {
  await restartSession();
}

export function clearAllOutputs(): void {
  const store = useNotebookStore.getState();
  releaseAllOutputs();
  store.clearAllOutputs();
}
