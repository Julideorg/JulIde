import type * as Monaco from "monaco-editor";
import { isNotebookSource, parseJupytext } from "../../../notebook/jupytext";
import { useNotebookStore } from "../../../stores/useNotebookStore";
import type { NotebookCellLayer } from "./cellZones";
import { runAll, runBelow, runCell } from "./cellActions";

/**
 * The per-cell toolbar, as a CodeLens above each `# %%` marker.
 *
 * CodeLens rather than a content widget per cell: Monaco owns the lifecycle,
 * virtualization and re-resolution on edit — which is the expensive part — and it is the
 * same affordance VS Code puts on percent-format files, so it needs no explaining. A
 * widget per cell would mean unbounded DOM plus manual position bookkeeping on every
 * keystroke; decoration `before` content has no real click target.
 */

let registered: Monaco.IDisposable[] = [];
/** Set by the editor that currently owns the cell layer. */
let activeLayer: NotebookCellLayer | null = null;
let activeEditor: Monaco.editor.IStandaloneCodeEditor | null = null;

export function setActiveCellLayer(
  editor: Monaco.editor.IStandaloneCodeEditor | null,
  layer: NotebookCellLayer | null,
): void {
  activeEditor = editor;
  activeLayer = layer;
}

/** The cell layer of whichever editor currently owns one, for palette commands. */
export function getActiveCellLayer(): NotebookCellLayer | null {
  return activeLayer;
}

const RUN_CELL = "julide.notebook.lens.runCell";
const RUN_BELOW = "julide.notebook.lens.runBelow";
const RUN_ALL = "julide.notebook.lens.runAll";

export function registerCellLens(monaco: typeof Monaco): void {
  // Idempotent: monacoSetup runs once, but a hot reload would otherwise stack providers.
  for (const d of registered) d.dispose();
  registered = [];

  // Monaco types this as IEvent<CodeLensProvider>; it only uses it as a signal.
  const onDidChange = new monaco.Emitter<Monaco.languages.CodeLensProvider>();

  registered.push(
    monaco.editor.registerCommand(RUN_CELL, (_accessor, line: number) => {
      if (activeEditor && activeLayer) void runCell(activeEditor, activeLayer, line);
    }),
    monaco.editor.registerCommand(RUN_BELOW, (_accessor, line: number) => {
      if (!activeEditor || !activeLayer) return;
      activeEditor.setPosition({ lineNumber: line, column: 1 });
      void runBelow(activeEditor, activeLayer);
    }),
    monaco.editor.registerCommand(RUN_ALL, () => {
      if (activeEditor && activeLayer) void runAll(activeEditor, activeLayer);
    }),
  );

  const provider: Monaco.languages.CodeLensProvider = {
    onDidChange: onDidChange.event,
    provideCodeLenses(model) {
      const text = model.getValue();
      if (!isNotebookSource(text)) return { lenses: [], dispose: () => {} };

      const doc = parseJupytext(text);
      const store = useNotebookStore.getState();
      const lenses: Monaco.languages.CodeLens[] = [];

      doc.cells.forEach((cell, index) => {
        const line = cell.implicit ? cell.range.startLine : cell.range.markerLine;
        const range = {
          startLineNumber: line,
          startColumn: 1,
          endLineNumber: line,
          endColumn: 1,
        };

        if (cell.type !== "code") {
          lenses.push({
            range,
            command: { id: "", title: cell.type === "markdown" ? "Markdown" : "Raw" },
          });
          return;
        }

        const cellId = activeLayer?.cellIdAtLine(line) ?? null;
        const state = cellId ? store.cells[cellId] : undefined;
        const badge =
          state?.status === "running"
            ? "Running…"
            : state?.status === "queued"
              ? "Queued"
              : state?.executionCount != null
                ? `[${state.executionCount}]`
                : "[ ]";

        lenses.push({ range, command: { id: RUN_CELL, title: "▸ Run Cell", arguments: [line] } });
        lenses.push({
          range,
          command: { id: RUN_BELOW, title: "Run Below", arguments: [line] },
        });
        if (index === 0) {
          lenses.push({ range, command: { id: RUN_ALL, title: "Run All" } });
        }
        lenses.push({ range, command: { id: "", title: badge } });
      });

      return { lenses, dispose: () => {} };
    },
    resolveCodeLens: (_model, lens) => lens,
  };
  registered.push(monaco.languages.registerCodeLensProvider("julia", provider));

  // Execution counts and status live in the store, so the lenses have to be recomputed
  // when it changes, not only when the text does.
  let scheduled = false;
  const unsubscribe = useNotebookStore.subscribe(() => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      onDidChange.fire(provider);
    });
  });
  registered.push({ dispose: unsubscribe });
}
