import type * as Monaco from "monaco-editor";
import {
  parseJupytext,
  type JupytextCell,
  type JupytextDocument,
} from "../../../notebook/jupytext";
import { hashSource, useNotebookStore } from "../../../stores/useNotebookStore";
import { releaseOutputs } from "../../../services/notebookBlobs";

/**
 * Per-cell output panels, drawn as Monaco view zones.
 *
 * ## Identity comes from decorations, not indices
 *
 * Outputs have to survive typing, and keying them by cell index does not work: insert a
 * cell above and every output shifts up one, so cell 5's plot appears under cell 6.
 * Monaco already tracks decorations across edits exactly, so each cell gets a zero-width
 * anchor decoration on its marker line and identity is "which anchor is on this line
 * now". Insert above and the decorations move down with the text; the mapping needs no
 * heuristics at all. The source hash is then used only to decide whether an output is
 * *stale*, which is a separate question.
 *
 * ## Two disposal hazards, both specific to this codebase
 *
 * View zones belong to the **editor**, and `@monaco-editor/react` swaps the model on a
 * `path` change rather than remounting. Without tearing down on `onDidChangeModel`, one
 * file's outputs render at those line numbers inside the next file you open — the
 * fastest way to ship something visibly broken.
 *
 * Models are also cached forever by `getOrCreateModel`, so anchors on a closed tab's
 * model would leak. `dispose()` is called from the editor's own teardown.
 */

export interface CellPortal {
  cellId: string;
  host: HTMLDivElement;
}

interface Anchor {
  cellId: string;
  decorationId: string;
  zoneId: string | null;
  host: HTMLDivElement;
  inner: HTMLDivElement;
  zone: Monaco.editor.IViewZone | null;
  observer: ResizeObserver | null;
  /** The body line the zone currently sits after. */
  afterLine: number;
}

let nextCellId = 0;

export class NotebookCellLayer {
  private editor: Monaco.editor.IStandaloneCodeEditor;
  private anchors: Anchor[] = [];
  private decorations: Monaco.editor.IEditorDecorationsCollection;
  private onPortalsChanged: (portals: CellPortal[]) => void;
  private disposables: Monaco.IDisposable[] = [];
  private disposed = false;

  constructor(
    editor: Monaco.editor.IStandaloneCodeEditor,
    onPortalsChanged: (portals: CellPortal[]) => void,
  ) {
    this.editor = editor;
    this.onPortalsChanged = onPortalsChanged;
    this.decorations = editor.createDecorationsCollection([]);
    // The model swap, not a remount — see the note above.
    this.disposables.push(editor.onDidChangeModel(() => this.clear()));
  }

  /** The cell containing a 1-based line, if it has an anchor. */
  cellIdAtLine(line: number): string | null {
    const model = this.editor.getModel();
    if (!model) return null;
    const doc = parseJupytext(model.getValue());
    const anchorLines = this.currentAnchorLines();
    for (const cell of doc.cells) {
      const from = cell.implicit ? cell.range.startLine : cell.range.markerLine;
      const to = Math.max(cell.range.endLine, from);
      if (line < from || line > to) continue;
      const found = anchorLines.get(from);
      return found ?? null;
    }
    return null;
  }

  /** Reconcile zones against the current document. Safe to call on every change. */
  sync(doc?: JupytextDocument): void {
    if (this.disposed) return;
    const model = this.editor.getModel();
    if (!model) return;
    const parsed = doc ?? parseJupytext(model.getValue());

    const byLine = this.currentAnchorLines();
    const used = new Set<string>();
    const keep: Anchor[] = [];
    const store = useNotebookStore.getState();

    for (const cell of parsed.cells) {
      const anchorLine = cell.implicit ? cell.range.startLine : cell.range.markerLine;
      const existingId = byLine.get(anchorLine);
      let anchor = existingId
        ? this.anchors.find((a) => a.cellId === existingId && !used.has(a.cellId))
        : undefined;

      if (!anchor) {
        anchor = this.createAnchor(anchorLine);
      }
      used.add(anchor.cellId);
      keep.push(anchor);

      const state = store.cells[anchor.cellId];
      if (state) {
        // Stale rather than dropped: a one-character fix should not silently discard a
        // thirty-second plot. Jupyter shows the old output too.
        const changed = state.sourceHash !== "" && state.sourceHash !== hashSource(cell.source);
        if (changed !== state.stale) store.markStale(anchor.cellId, changed);
      }

      const hasContent = (state?.outputs.length ?? 0) > 0;
      if (hasContent) this.ensureZone(anchor, Math.max(cell.range.endLine, anchorLine));
      else this.removeZone(anchor);
    }

    // Anything unmatched had its cell deleted.
    const dropped = this.anchors.filter((a) => !used.has(a.cellId));
    for (const anchor of dropped) this.destroyAnchor(anchor);
    if (dropped.length > 0) {
      const ids = dropped.map((a) => a.cellId);
      for (const id of ids) releaseOutputs(store.cells[id]?.outputs ?? []);
      store.forgetCells(ids);
    }

    this.anchors = keep;
    this.decorations.set(
      this.anchors.map((a, i) => ({
        range: {
          startLineNumber: this.anchorLineOf(a) ?? parsed.cells[i]?.range.markerLine ?? 1,
          startColumn: 1,
          endLineNumber: this.anchorLineOf(a) ?? parsed.cells[i]?.range.markerLine ?? 1,
          endColumn: 1,
        },
        // stickiness 1 = NeverGrowsWhenTypingAtEdges, so the anchor tracks its
        // line without swallowing text typed at the start of it.
        options: { stickiness: 1 },
      })),
    );
    this.emitPortals();
  }

  dispose(): void {
    this.disposed = true;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.clear();
    this.decorations.clear();
  }

  /* ── internals ─────────────────────────────────────────────────────────── */

  private clear(): void {
    for (const anchor of this.anchors) this.destroyAnchor(anchor);
    this.anchors = [];
    this.decorations.set([]);
    this.emitPortals();
  }

  private currentAnchorLines(): Map<number, string> {
    const model = this.editor.getModel();
    const out = new Map<number, string>();
    if (!model) return out;
    for (const anchor of this.anchors) {
      const range = model.getDecorationRange(anchor.decorationId);
      if (range) out.set(range.startLineNumber, anchor.cellId);
    }
    return out;
  }

  private anchorLineOf(anchor: Anchor): number | null {
    const model = this.editor.getModel();
    const range = model?.getDecorationRange(anchor.decorationId);
    return range?.startLineNumber ?? null;
  }

  private createAnchor(line: number): Anchor {
    const model = this.editor.getModel()!;
    // Added through the model rather than the collection so we get a stable id back;
    // the collection is re-set wholesale on each sync for positioning.
    const [decorationId] = model.deltaDecorations(
      [],
      [
        {
          range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
          options: { stickiness: 1 },
        },
      ],
    );

    const host = document.createElement("div");
    host.className = "notebook-zone-host";
    const inner = document.createElement("div");
    inner.className = "notebook-zone-inner";
    host.appendChild(inner);

    return {
      cellId: `c${nextCellId++}`,
      decorationId,
      zoneId: null,
      host,
      inner,
      zone: null,
      observer: null,
      afterLine: line,
    };
  }

  private destroyAnchor(anchor: Anchor): void {
    this.removeZone(anchor);
    const model = this.editor.getModel();
    if (model) model.deltaDecorations([anchor.decorationId], []);
  }

  private ensureZone(anchor: Anchor, afterLine: number): void {
    if (anchor.zoneId !== null) {
      if (anchor.afterLine !== afterLine && anchor.zone) {
        anchor.afterLine = afterLine;
        anchor.zone.afterLineNumber = afterLine;
        const id = anchor.zoneId;
        this.editor.changeViewZones((a) => a.layoutZone(id));
      }
      return;
    }

    const zone: Monaco.editor.IViewZone = {
      afterLineNumber: afterLine,
      domNode: anchor.host,
      heightInPx: 0,
      // Buttons and text selection inside the panel need the mouse.
      suppressMouseDown: false,
    };
    anchor.zone = zone;
    anchor.afterLine = afterLine;
    this.editor.changeViewZones((accessor) => {
      anchor.zoneId = accessor.addZone(zone);
    });

    // Observe `inner`, never `host`: Monaco sets the host's height inline, so observing
    // it feeds its own imposed height back and relayouts forever.
    anchor.observer = new ResizeObserver((entries) => {
      const height = Math.ceil(entries[0].contentRect.height);
      if (!anchor.zone || anchor.zoneId === null) return;
      // 1px hysteresis plus rAF, or the browser logs "ResizeObserver loop completed
      // with undelivered notifications" on every frame.
      if (Math.abs(height - (anchor.zone.heightInPx ?? 0)) < 1) return;
      anchor.zone.heightInPx = height;
      const id = anchor.zoneId;
      requestAnimationFrame(() => {
        if (this.disposed) return;
        this.editor.changeViewZones((a) => a.layoutZone(id));
      });
    });
    anchor.observer.observe(anchor.inner);
  }

  private removeZone(anchor: Anchor): void {
    anchor.observer?.disconnect();
    anchor.observer = null;
    if (anchor.zoneId === null) return;
    const id = anchor.zoneId;
    anchor.zoneId = null;
    anchor.zone = null;
    this.editor.changeViewZones((accessor) => accessor.removeZone(id));
  }

  private emitPortals(): void {
    this.onPortalsChanged(
      this.anchors
        .filter((a) => a.zoneId !== null)
        .map((a) => ({ cellId: a.cellId, host: a.inner })),
    );
  }
}

/** The cell to run for a cursor position, creating an anchor if there is not one yet. */
export function cellForLine(
  layer: NotebookCellLayer,
  cell: JupytextCell,
): { cellId: string | null } {
  const from = cell.implicit ? cell.range.startLine : cell.range.markerLine;
  return { cellId: layer.cellIdAtLine(from) };
}
