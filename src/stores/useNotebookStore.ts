import { create } from "zustand";

/**
 * Notebook cell state: status, execution counts, and outputs.
 *
 * **Deliberately not using the immer middleware**, unlike every other store here.
 * `useIdeStore.ts` documents the reason at length: immer's auto-freeze walks the whole
 * draft on every write, which turns an append into O(n) and a stream of appends into
 * O(n²) — it measured at ~30s for 5000 output lines. Notebook output is exactly that
 * shape, and worse, a single Julia backtrace arrives as ~25 separate chunks.
 *
 * Image bytes are not in here either; see `notebookBlobs.ts`. The store holds a URL
 * string, so a selector never has to diff a multi-megabyte base64 payload.
 */

export type CellStatus = "idle" | "queued" | "running" | "ok" | "error" | "aborted";

export type SessionStatus = "off" | "starting" | "ready" | "busy" | "error";

export interface CellOutput {
  /** Stable per output, so the blob registry can key on it. */
  id: string;
  kind: "stream" | "display" | "result" | "error";
  /** stream only. */
  name?: "stdout" | "stderr";
  /** stream / the text-plain fallback of a bundle. */
  text?: string;
  /** display / result — an object URL, never the bytes. */
  imageUrl?: string;
  /** display / result — sanitized HTML, when the bundle carried text/html. */
  html?: string;
  /** result only. */
  executionCount?: number;
  /** error only. */
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

export interface CellState {
  status: CellStatus;
  executionCount: number | null;
  /** The source changed since these outputs were produced, so they are shown dimmed. */
  stale: boolean;
  sourceHash: string;
  outputs: CellOutput[];
}

const EMPTY_CELL: CellState = {
  status: "idle",
  executionCount: null,
  stale: false,
  sourceHash: "",
  outputs: [],
};

/** Per-cell caps, so one runaway loop cannot make the editor unusable. */
const MAX_OUTPUTS_PER_CELL = 200;
const MAX_STREAM_CHARS = 200_000;

interface NotebookStore {
  sessionId: string | null;
  sessionStatus: SessionStatus;
  sessionMessage: string;
  juliaVersion: string;
  /** exec id → cell id. The only thing correlating a driver message to a cell. */
  execToCell: Record<string, string>;
  cells: Record<string, CellState>;

  setSession: (id: string | null, status: SessionStatus, message?: string) => void;
  setJuliaVersion: (version: string) => void;
  beginExec: (execId: string, cellId: string, sourceHash: string) => void;
  setCellStatus: (cellId: string, status: CellStatus, executionCount?: number | null) => void;
  appendOutput: (cellId: string, output: CellOutput) => void;
  markStale: (cellId: string, stale: boolean) => void;
  clearOutputs: (cellId: string) => void;
  clearAllOutputs: () => void;
  forgetCells: (cellIds: string[]) => void;
  reset: () => void;
}

export const useNotebookStore = create<NotebookStore>()((set, get) => ({
  sessionId: null,
  sessionStatus: "off",
  sessionMessage: "",
  juliaVersion: "",
  execToCell: {},
  cells: {},

  setSession: (id, status, message = "") =>
    set({ sessionId: id, sessionStatus: status, sessionMessage: message }),

  setJuliaVersion: (version) => set({ juliaVersion: version }),

  beginExec: (execId, cellId, sourceHash) =>
    set((s) => ({
      execToCell: { ...s.execToCell, [execId]: cellId },
      cells: {
        ...s.cells,
        [cellId]: {
          ...(s.cells[cellId] ?? EMPTY_CELL),
          status: "queued",
          stale: false,
          sourceHash,
          // Re-running replaces the previous output rather than appending to it, which
          // is what Jupyter does and what anyone re-running a plot expects.
          outputs: [],
        },
      },
    })),

  setCellStatus: (cellId, status, executionCount) =>
    set((s) => {
      const cell = s.cells[cellId] ?? EMPTY_CELL;
      return {
        cells: {
          ...s.cells,
          [cellId]: {
            ...cell,
            status,
            executionCount: executionCount === undefined ? cell.executionCount : executionCount,
          },
        },
      };
    }),

  appendOutput: (cellId, output) =>
    set((s) => {
      const cell = s.cells[cellId] ?? EMPTY_CELL;
      const outputs = cell.outputs;
      const last = outputs[outputs.length - 1];

      // Coalesce consecutive stream chunks of the same name into one entry. Rust
      // already merges what it can, but a slow-printing loop still arrives in pieces,
      // and one entry per chunk would mean one DOM node per chunk.
      if (
        output.kind === "stream" &&
        last?.kind === "stream" &&
        last.name === output.name &&
        (last.text?.length ?? 0) < MAX_STREAM_CHARS
      ) {
        const merged: CellOutput = { ...last, text: (last.text ?? "") + (output.text ?? "") };
        return {
          cells: {
            ...s.cells,
            [cellId]: { ...cell, outputs: [...outputs.slice(0, -1), merged] },
          },
        };
      }

      if (outputs.length >= MAX_OUTPUTS_PER_CELL) return {};
      return {
        cells: { ...s.cells, [cellId]: { ...cell, outputs: [...outputs, output] } },
      };
    }),

  markStale: (cellId, stale) =>
    set((s) => {
      const cell = s.cells[cellId];
      if (!cell || cell.stale === stale) return {};
      return { cells: { ...s.cells, [cellId]: { ...cell, stale } } };
    }),

  clearOutputs: (cellId) =>
    set((s) => {
      const cell = s.cells[cellId];
      if (!cell) return {};
      return { cells: { ...s.cells, [cellId]: { ...cell, outputs: [], stale: false } } };
    }),

  clearAllOutputs: () =>
    set((s) => {
      const cells: Record<string, CellState> = {};
      for (const [id, cell] of Object.entries(s.cells)) {
        cells[id] = { ...cell, outputs: [], stale: false };
      }
      return { cells };
    }),

  forgetCells: (cellIds) => {
    if (cellIds.length === 0) return;
    const drop = new Set(cellIds);
    const { cells, execToCell } = get();
    const nextCells: Record<string, CellState> = {};
    for (const [id, cell] of Object.entries(cells)) if (!drop.has(id)) nextCells[id] = cell;
    const nextExec: Record<string, string> = {};
    for (const [execId, cellId] of Object.entries(execToCell)) {
      if (!drop.has(cellId)) nextExec[execId] = cellId;
    }
    set({ cells: nextCells, execToCell: nextExec });
  },

  reset: () =>
    set({
      sessionId: null,
      sessionStatus: "off",
      sessionMessage: "",
      juliaVersion: "",
      execToCell: {},
      cells: {},
    }),
}));

/** Cheap, stable hash for "has this cell's source changed since it ran?". */
export function hashSource(source: string): string {
  let h = 2166136261;
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
