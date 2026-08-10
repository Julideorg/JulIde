import { invoke } from "@tauri-apps/api/core";
import { parseJupytext } from "./jupytext";
import {
  combineInputsWithOutputs,
  jupytextToNotebook,
  notebookToJupytext,
  pairedFormats,
  readNotebook,
  writeNotebook,
  type Notebook,
} from "./ipynb";

/**
 * Keeping a jupytext `.jl` and its paired `.ipynb` in step.
 *
 * ## When sync fires, and why not on autosave
 *
 * The editor autosaves the `.jl` on an 800 ms debounce, and the `.ipynb` is deliberately
 * **not** regenerated there. Four reasons, in descending order of how badly it goes:
 *
 *  1. It would destroy conflict detection. The whole scheme rests on comparing what is
 *     on disk against what we last wrote; writing constantly makes "someone ran this in
 *     Jupyter" indistinguishable from "we just wrote it".
 *  2. Mid-typing, the cell being edited no longer content-matches, so the positional
 *     fallback reassigns outputs — and un-reassigns them on the next keystroke. The
 *     `.ipynb` would flap, and anything watching it would see garbage.
 *  3. The workspace watcher debounces a full tree walk and a `git status` off any
 *     event, so this would run both roughly every 1.5 s while typing.
 *  4. A notebook with plots is megabytes.
 *
 * Nothing is lost by waiting: the `.ipynb` is a pure projection of the `.jl` plus
 * preserved outputs, so a crash between autosave and sync costs only the projection.
 *
 * ## Why this cannot loop
 *
 * Three independent guards, cheapest first. The third is the one that makes it
 * *provably* convergent rather than merely unlikely to loop.
 */

export interface FileStat {
  exists: boolean;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

export interface PairSpec {
  jlPath: string;
  ipynbPath: string;
  formats: string;
}

interface PairState {
  spec: PairSpec;
  /** Stamps from the last moment the two agreed, plus the `.jl` text that produced them. */
  synced: { ipynb: FileStat; jlText: string } | null;
  /** Set when the `.ipynb` cannot be parsed. Never overwrite a file we do not understand. */
  broken?: string;
}

export type SyncReason = "save" | "post-execution" | "open" | "close" | "manual";
export type SyncStatus = "ok" | "skipped" | "unpaired" | "conflict" | "error";
export interface SyncResult {
  status: SyncStatus;
  message?: string;
}

/** Keyed by both paths, so an event on either side finds the pair. */
const pairs = new Map<string, PairState>();
/** Single-flight per pair: a sync is several IPC round trips. */
const inFlight = new Map<string, Promise<SyncResult>>();

/**
 * Guard 1: what we last wrote, by path.
 *
 * Stat-based rather than time-based, because one `std::fs::write` can produce two or
 * three inotify events and any timing window would be a guess.
 */
const selfWrites = new Map<string, FileStat>();

const stat = (path: string) => invoke<FileStat>("fs_stat", { path });
const readFile = (path: string) => invoke<string>("fs_read_file", { path });

/** Write, then record the stamp so the watcher event it causes can be recognised. */
export async function writeTracked(path: string, content: string): Promise<FileStat> {
  await invoke("fs_write_file_atomic", { path, content });
  const stamp = await stat(path);
  selfWrites.set(path, stamp);
  return stamp;
}

function sameStamp(a: FileStat | undefined, b: FileStat): boolean {
  return !!a && a.exists === b.exists && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** Swap `.jl` for `.ipynb`, or the reverse. */
function siblingPath(path: string, toExtension: string): string {
  return path.replace(/\.[^./\\]+$/, toExtension);
}

/**
 * Resolve the pairing a `.jl` file declares, or null.
 *
 * jupytext's prefix syntax (`notebooks//ipynb,scripts//jl:percent`) is deliberately
 * unsupported for now: silently pairing the wrong file is worse than not pairing.
 */
export function resolvePair(jlPath: string, text: string): PairSpec | null {
  const formats = pairedFormats(text);
  if (!formats) return null;
  if (!/(^|,)\s*ipynb\s*(,|$)/.test(formats)) return null;
  if (formats.includes("//")) return null;
  return { jlPath, ipynbPath: siblingPath(jlPath, ".ipynb"), formats };
}

function registerPair(spec: PairSpec): PairState {
  const existing = pairs.get(spec.jlPath);
  if (existing) return existing;
  const state: PairState = { spec, synced: null };
  pairs.set(spec.jlPath, state);
  pairs.set(spec.ipynbPath, state);
  return state;
}

export function pairFor(path: string): PairSpec | null {
  return pairs.get(path)?.spec ?? null;
}

/** Test seam. */
export function __resetPairing(): void {
  pairs.clear();
  inFlight.clear();
  selfWrites.clear();
}

/**
 * Regenerate the paired `.ipynb` from the current `.jl` text, preserving outputs.
 */
export async function syncToNotebook(
  jlPath: string,
  jlText: string,
  _reason: SyncReason,
): Promise<SyncResult> {
  const spec = resolvePair(jlPath, jlText);
  if (!spec) return { status: "unpaired" };

  const running = inFlight.get(spec.jlPath);
  if (running) return running;

  const work = (async (): Promise<SyncResult> => {
    const state = registerPair(spec);
    if (state.broken) return { status: "error", message: state.broken };

    const current = await stat(spec.ipynbPath);
    let previous: Notebook | undefined;

    if (current.exists) {
      let raw: string;
      try {
        raw = await readFile(spec.ipynbPath);
        previous = readNotebook(raw);
      } catch (e) {
        state.broken = `${spec.ipynbPath} is not a notebook julIDE can read: ${String(e)}`;
        return { status: "error", message: state.broken };
      }

      // Changed underneath us since our last write?
      if (state.synced && !sameStamp(state.synced.ipynb, current)) {
        const before = jupytextToNotebook(parseJupytext(state.synced.jlText));
        const sourcesMatch =
          before.cells.length === previous.cells.length &&
          before.cells.every(
            (c, i) =>
              c.cell_type === previous!.cells[i].cell_type &&
              c.source === previous!.cells[i].source,
          );
        // Only outputs moved — someone ran it in Jupyter. That is not a conflict; adopt
        // the outputs and carry on. Different *sources* on both sides is a real one.
        if (!sourcesMatch) {
          return {
            status: "conflict",
            message: `${spec.ipynbPath} changed on disk since julIDE last wrote it.`,
          };
        }
      }
    }

    const next = jupytextToNotebook(parseJupytext(jlText), previous);
    const serialized = writeNotebook(next);

    // Guard 3, and the reason this is provably convergent: both directions are pure
    // functions, so a second pass produces identical bytes and writes nothing at all —
    // even if guards 1 and 2 both misfire.
    if (previous && writeNotebook(previous) === serialized) {
      state.synced = { ipynb: current, jlText };
      return { status: "skipped" };
    }

    const stamp = await writeTracked(spec.ipynbPath, serialized);
    state.synced = { ipynb: stamp, jlText };
    return { status: "ok" };
  })().finally(() => inFlight.delete(spec.jlPath));

  inFlight.set(spec.jlPath, work);
  return work;
}

/** Regenerate the `.jl` from an `.ipynb`. Returns the text that was written. */
export async function syncFromNotebook(ipynbPath: string): Promise<string> {
  const raw = await readFile(ipynbPath);
  const nb = readNotebook(raw);
  const text = notebookToJupytext(nb);
  const jlPath = siblingPath(ipynbPath, ".jl");
  await writeTracked(jlPath, text);
  const state = registerPair({ jlPath, ipynbPath, formats: "ipynb,jl:percent" });
  state.synced = { ipynb: await stat(ipynbPath), jlText: text };
  return text;
}

/**
 * Guard 2: first refusal on a watcher event.
 *
 * Returns true when the pairing engine owns the event and the generic reload path
 * should not also act on it.
 */
export async function handleFsChange(path: string): Promise<boolean> {
  const state = pairs.get(path);
  if (!state) return false;

  const current = await stat(path);
  const recorded = selfWrites.get(path);
  if (sameStamp(recorded, current)) {
    // Our own write coming back around.
    return true;
  }
  // A genuine external change. The `.ipynb` is never an open tab, so nothing else
  // reacts to it; the `.jl` is left to the normal reload path.
  return path === state.spec.ipynbPath;
}

/**
 * Open an `.ipynb`: materialize or refresh the sibling `.jl` and return its path.
 *
 * jupytext's own workflow — the script is what you edit. Newer-mtime-wins matches
 * `jupytext --sync`.
 */
export async function materializePair(ipynbPath: string): Promise<string> {
  const jlPath = siblingPath(ipynbPath, ".jl");
  const [ipynbStat, jlStat] = await Promise.all([stat(ipynbPath), stat(jlPath)]);

  if (!jlStat.exists) {
    await syncFromNotebook(ipynbPath);
    return jlPath;
  }

  const jlText = await readFile(jlPath);
  if (jlStat.mtimeMs >= ipynbStat.mtimeMs) {
    // The script is newer, so it wins — regenerate the notebook, keeping its outputs.
    await syncToNotebook(jlPath, jlText, "open");
  } else {
    await syncFromNotebook(ipynbPath);
  }
  registerPair({ jlPath, ipynbPath, formats: "ipynb,jl:percent" });
  return jlPath;
}

/** Adopt an already-open `.jl` so later saves sync without needing a first open. */
export function registerFromSource(jlPath: string, text: string): PairSpec | null {
  const spec = resolvePair(jlPath, text);
  if (!spec) return null;
  registerPair(spec);
  return spec;
}

export function isNotebookPath(path: string): boolean {
  return path.toLowerCase().endsWith(".ipynb");
}

/** Combine for callers that already hold both notebooks. Re-exported for tests. */
export { combineInputsWithOutputs };
