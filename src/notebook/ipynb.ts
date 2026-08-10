import {
  commentBody,
  parseJupytext,
  serializeJupytext,
  type CellType,
  type JupytextCell,
  type JupytextDocument,
} from "./jupytext";

/**
 * nbformat 4.5 ⇄ jupytext percent.
 *
 * ## Byte compatibility is a requirement, not a nicety
 *
 * nbformat writes notebooks as
 * `json.dumps(nb, indent=1, sort_keys=True, separators=(",", ": "), ensure_ascii=False)`
 * plus a trailing newline, and splits `source` / `stream.text` / text mime values into
 * lists of lines **with the newline kept** (`str.splitlines(True)`).
 *
 * `JSON.stringify(sortKeysDeep(nb), null, 1) + "\n"` reproduces that exactly. Getting it
 * right means git diffs stay minimal and Jupyter, nbdime and jupytext all see a file
 * they would have written themselves; getting it wrong means every sync rewrites the
 * whole file.
 */

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
export type MimeBundle = Record<string, Json>;

interface BaseCell {
  id: string;
  metadata: Record<string, Json>;
  source: string;
}

export interface IpynbCodeCell extends BaseCell {
  cell_type: "code";
  outputs: IpynbOutput[];
  execution_count: number | null;
}
export interface IpynbMarkdownCell extends BaseCell {
  cell_type: "markdown";
  attachments?: Record<string, MimeBundle>;
}
export interface IpynbRawCell extends BaseCell {
  cell_type: "raw";
  attachments?: Record<string, MimeBundle>;
}
export type IpynbCell = IpynbCodeCell | IpynbMarkdownCell | IpynbRawCell;

export type IpynbOutput =
  | { output_type: "stream"; name: string; text: string }
  | { output_type: "display_data"; data: MimeBundle; metadata: Record<string, Json> }
  | {
      output_type: "execute_result";
      data: MimeBundle;
      metadata: Record<string, Json>;
      execution_count: number | null;
    }
  | { output_type: "error"; ename: string; evalue: string; traceback: string[] };

export interface Notebook {
  cells: IpynbCell[];
  metadata: Record<string, Json>;
  nbformat: number;
  nbformat_minor: number;
}

/** Mime values nbformat stores line-split, alongside anything `text/*`. */
const LINE_SPLIT_MIMES = ["image/svg+xml", "application/javascript"];

/** `"a\nb"` → `["a\n", "b"]`, matching Python's `splitlines(True)`. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.split(/(?<=\n)/);
}

const joinLines = (value: Json): string => (Array.isArray(value) ? value.join("") : String(value));

function isLineSplit(mime: string): boolean {
  return mime.startsWith("text/") || LINE_SPLIT_MIMES.includes(mime);
}

/**
 * nbformat 4.5 cell ids: `^[a-zA-Z0-9-_]{1,64}$`.
 *
 * Deterministic-per-call rather than random, because `Math.random` in a pure module
 * makes round-trip tests untestable. Callers preserve an existing id whenever they can,
 * so a fresh one is only minted for a genuinely new cell.
 */
let idCounter = 0;
export function newCellId(): string {
  idCounter = (idCounter + 1) % 0xffffff;
  return `c${idCounter.toString(36).padStart(4, "0")}`;
}

/** Sort keys everywhere, matching Python's `sort_keys=True`. */
function sortKeysDeep(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, Json> = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
  return out;
}

/* ── Reading and writing ──────────────────────────────────────────────────── */

export function readNotebook(json: string): Notebook {
  const raw = JSON.parse(json) as Record<string, Json>;
  const cells = (Array.isArray(raw.cells) ? raw.cells : []).map((c) => {
    const cell = c as Record<string, Json>;
    const base = {
      id: typeof cell.id === "string" ? cell.id : newCellId(),
      metadata: (cell.metadata as Record<string, Json>) ?? {},
      source: joinLines(cell.source ?? ""),
    };
    if (cell.cell_type === "code") {
      return {
        ...base,
        cell_type: "code" as const,
        execution_count: typeof cell.execution_count === "number" ? cell.execution_count : null,
        outputs: (Array.isArray(cell.outputs) ? cell.outputs : []).map((o) => {
          const out = o as Record<string, Json>;
          if (out.output_type === "stream") {
            return {
              output_type: "stream" as const,
              name: String(out.name ?? "stdout"),
              text: joinLines(out.text ?? ""),
            };
          }
          if (out.output_type === "error") {
            return {
              output_type: "error" as const,
              ename: String(out.ename ?? ""),
              evalue: String(out.evalue ?? ""),
              traceback: (Array.isArray(out.traceback) ? out.traceback : []).map(String),
            };
          }
          const data: MimeBundle = {};
          for (const [mime, value] of Object.entries((out.data as MimeBundle) ?? {})) {
            data[mime] = isLineSplit(mime) ? joinLines(value) : value;
          }
          if (out.output_type === "execute_result") {
            return {
              output_type: "execute_result" as const,
              data,
              metadata: (out.metadata as Record<string, Json>) ?? {},
              execution_count: typeof out.execution_count === "number" ? out.execution_count : null,
            };
          }
          return {
            output_type: "display_data" as const,
            data,
            metadata: (out.metadata as Record<string, Json>) ?? {},
          };
        }),
      };
    }
    const kind = cell.cell_type === "raw" ? ("raw" as const) : ("markdown" as const);
    return { ...base, cell_type: kind };
  });

  return {
    cells,
    metadata: (raw.metadata as Record<string, Json>) ?? {},
    nbformat: typeof raw.nbformat === "number" ? raw.nbformat : 4,
    nbformat_minor: typeof raw.nbformat_minor === "number" ? raw.nbformat_minor : 5,
  };
}

export function writeNotebook(nb: Notebook): string {
  const cells = nb.cells.map((cell) => {
    const base: Record<string, Json> = {
      cell_type: cell.cell_type,
      id: cell.id,
      metadata: cell.metadata as Json,
      source: splitLines(cell.source),
    };
    if (cell.cell_type !== "code") return base;
    base.execution_count = cell.execution_count;
    base.outputs = cell.outputs.map((output) => {
      if (output.output_type === "stream") {
        return {
          output_type: "stream",
          name: output.name,
          text: splitLines(output.text),
        } as Json;
      }
      if (output.output_type === "error") {
        return {
          output_type: "error",
          ename: output.ename,
          evalue: output.evalue,
          traceback: output.traceback,
        } as Json;
      }
      const data: Record<string, Json> = {};
      for (const [mime, value] of Object.entries(output.data)) {
        data[mime] = isLineSplit(mime) && typeof value === "string" ? splitLines(value) : value;
      }
      const common: Record<string, Json> = {
        output_type: output.output_type,
        data,
        metadata: output.metadata as Json,
      };
      if (output.output_type === "execute_result") {
        common.execution_count = output.execution_count;
      }
      return common as Json;
    });
    return base;
  });

  const doc: Json = {
    cells: cells as Json,
    metadata: nb.metadata as Json,
    nbformat: nb.nbformat,
    nbformat_minor: nb.nbformat_minor,
  };
  return JSON.stringify(sortKeysDeep(doc), null, 1) + "\n";
}

/* ── Conversion ───────────────────────────────────────────────────────────── */

/**
 * Notebook metadata that belongs in the `.jl` header.
 *
 * Mirrors jupytext's `_DEFAULT_NOTEBOOK_METADATA`. Everything else — `language_info`,
 * `widgets` — lives only in the `.ipynb` and is carried over on sync rather than
 * regenerated, because the `.jl` never held it.
 */
const HEADER_METADATA = ["jupytext", "kernelspec", "kernel_info", "orphan", "tocdepth"];

export function jupytextToNotebook(doc: JupytextDocument, previous?: Notebook): Notebook {
  const metadata: Record<string, Json> = {};
  // Non-header metadata is the previous file's to keep; we have no source for it.
  for (const [key, value] of Object.entries(previous?.metadata ?? {})) {
    if (!HEADER_METADATA.includes(key)) metadata[key] = value;
  }
  for (const [key, value] of Object.entries(headerMetadata(doc))) metadata[key] = value;
  if (!metadata.language_info) {
    metadata.language_info = {
      name: "julia",
      file_extension: ".jl",
      mimetype: "application/julia",
    };
  }

  const cells: IpynbCell[] = doc.cells.map((cell) => {
    if (cell.type === "code") {
      return {
        id: newCellId(),
        cell_type: "code",
        metadata: {},
        source: cell.source,
        outputs: [],
        execution_count: null,
      };
    }
    return {
      id: newCellId(),
      cell_type: cell.type,
      metadata: {},
      source: cell.source,
    };
  });

  const nb: Notebook = { cells, metadata, nbformat: 4, nbformat_minor: 5 };
  return previous ? combineInputsWithOutputs(nb, previous) : nb;
}

/** Read the `jupyter:` block of a jupytext header into notebook metadata. */
function headerMetadata(doc: JupytextDocument): Record<string, Json> {
  if (!doc.header) return {};
  const root = parseSimpleYaml(doc.header.lines);
  const jupyter = root["jupyter"];
  if (!jupyter || typeof jupyter !== "object" || Array.isArray(jupyter)) return {};
  return jupyter as Record<string, Json>;
}

export function notebookToJupytext(nb: Notebook, formats = "ipynb,jl:percent"): string {
  const kernelspec = nb.metadata.kernelspec as Record<string, Json> | undefined;
  const header: string[] = ["jupyter:", "  jupytext:", `    formats: ${formats}`];
  header.push("    text_representation:", "      extension: .jl");
  header.push("      format_name: percent", "      format_version: '1.3'");
  if (kernelspec) {
    header.push("  kernelspec:");
    for (const key of ["display_name", "language", "name"]) {
      const value = kernelspec[key];
      if (typeof value === "string") header.push(`    ${key}: ${value}`);
    }
  }

  const cells: JupytextCell[] = nb.cells.map((cell) => ({
    type: cell.cell_type as CellType,
    source: cell.source.replace(/\n$/, ""),
    metadata: {},
    cellDepth: 0,
    rawMarker: null,
    rawBody: [],
    dirty: true,
    implicit: false,
    legacy: false,
    range: { markerLine: 0, startLine: 0, endLine: 0 },
  }));

  return serializeJupytext({
    header: {
      lines: header,
      preamble: [],
      range: { startLine: 1, endLine: 1 },
      blanksAfter: 1,
    },
    cells,
    eol: "\n",
    endsWithNewline: true,
    dialect: "percent",
  });
}

/* ── Output reconciliation ────────────────────────────────────────────────── */

/**
 * jupytext's `black_invariant`, adapted for Julia.
 *
 * Only whitespace and trailing commas are stripped. jupytext also strips quotes,
 * parentheses and backslashes because *black* rewrites those; JuliaFormatter does not,
 * and stripping them here would make `f(1)` and `f 1` compare equal.
 */
export function formatterInvariant(text: string): string {
  return text.replace(/[\s,]/g, "");
}

/**
 * Match each input cell to the output-bearing cell it came from.
 *
 * The four rules are jupytext's `map_outputs_to_inputs`, in order: an ordered content
 * match with a per-cell-type watermark, an unordered content match, a suffix match (a
 * cell that was split in two), and finally a positional fallback.
 */
export function mapOutputsToInputs(inputs: IpynbCell[], outputs: IpynbCell[]): (number | null)[] {
  const mapping: (number | null)[] = inputs.map(() => null);
  const claimed = new Set<number>();
  const watermark: Record<string, number> = {};

  const canonical = outputs.map((c) => formatterInvariant(c.source));

  // 1. Ordered content match.
  inputs.forEach((input, i) => {
    const key = formatterInvariant(input.source);
    const start = watermark[input.cell_type] ?? 0;
    for (let j = start; j < outputs.length; j++) {
      if (claimed.has(j) || outputs[j].cell_type !== input.cell_type) continue;
      if (canonical[j] !== key) continue;
      mapping[i] = j;
      claimed.add(j);
      watermark[input.cell_type] = j + 1;
      break;
    }
  });

  // 2. Unordered content match over what is left.
  inputs.forEach((input, i) => {
    if (mapping[i] !== null) return;
    const key = formatterInvariant(input.source);
    for (let j = 0; j < outputs.length; j++) {
      if (claimed.has(j) || outputs[j].cell_type !== input.cell_type) continue;
      if (canonical[j] !== key) continue;
      mapping[i] = j;
      claimed.add(j);
      break;
    }
  });

  // 3. Suffix match — recovers outputs when a cell was split in two.
  inputs.forEach((input, i) => {
    if (mapping[i] !== null) return;
    const key = formatterInvariant(input.source);
    if (!key) return;
    for (let j = 0; j < outputs.length; j++) {
      if (claimed.has(j) || outputs[j].cell_type !== input.cell_type) continue;
      if (!canonical[j].endsWith(key)) continue;
      mapping[i] = j;
      claimed.add(j);
      break;
    }
  });

  // 4. Positional fallback. This is what keeps an *edited* cell's outputs, which
  //    jupytext does too — dropping them means a typo fix silently discards a plot.
  let previous = -1;
  inputs.forEach((input, i) => {
    if (mapping[i] !== null) {
      previous = mapping[i]!;
      return;
    }
    const j = previous + 1;
    if (j >= outputs.length || claimed.has(j)) return;
    if (outputs[j].cell_type !== input.cell_type) return;
    if (!input.source.trim()) return;
    mapping[i] = j;
    claimed.add(j);
    previous = j;
  });

  return mapping;
}

export interface CombineOptions {
  /** `keep-stale` matches jupytext. `drop` discards outputs whose source changed. */
  editedCells?: "keep-stale" | "drop";
}

/** Carry outputs, execution counts, ids and cell metadata from `previous` onto `source`. */
export function combineInputsWithOutputs(
  source: Notebook,
  previous: Notebook,
  options: CombineOptions = {},
): Notebook {
  const mapping = mapOutputsToInputs(source.cells, previous.cells);

  const cells = source.cells.map((cell, i) => {
    const j = mapping[i];
    if (j === null) return cell;
    const old = previous.cells[j];

    const unchanged = formatterInvariant(old.source) === formatterInvariant(cell.source);
    if (!unchanged && options.editedCells === "drop") {
      return { ...cell, id: old.id };
    }

    const merged: IpynbCell = { ...cell, id: old.id, metadata: { ...old.metadata } };
    if (merged.cell_type === "code" && old.cell_type === "code") {
      merged.outputs = old.outputs;
      merged.execution_count = old.execution_count;
      if (!unchanged) {
        // Invisible to Jupyter, and enough for the view-zone renderer to grey it out.
        merged.metadata = {
          ...merged.metadata,
          julide: { staleOutputs: true },
        };
      } else if (merged.metadata.julide) {
        const { julide: _drop, ...rest } = merged.metadata;
        merged.metadata = rest;
      }
    }
    return merged;
  });

  return { ...source, cells };
}

/* ── Minimal YAML ─────────────────────────────────────────────────────────── */

/**
 * Block mappings with scalar leaves. That is the whole of what jupytext writes:
 * `yaml.safe_dump` of a nested dict of plain scalars, depth ≤ 3, no sequences, no
 * anchors, no block scalars.
 *
 * Hand-rolled rather than adding a dependency. The header comes from cloned
 * repositories, and a general YAML parser is a large amount of attack surface for
 * reading four keys. Anything it cannot model is preserved verbatim by the jupytext
 * layer and simply not understood here, which degrades to "julIDE does not know the
 * format string" rather than to data loss.
 */
export function parseSimpleYaml(lines: string[]): Record<string, Json> {
  const root: Record<string, Json> = {};
  const stack: Array<{ indent: number; node: Record<string, Json> }> = [{ indent: -1, node: root }];

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const match = /^([^:]+):\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1].trim();
    const rest = match[2].trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;

    if (rest === "") {
      const child: Record<string, Json> = {};
      parent[key] = child;
      stack.push({ indent, node: child });
    } else {
      parent[key] = unquote(rest);
    }
  }
  return root;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return value;
}

/** The `jupytext.formats` string of a `.jl` header, if it declares one. */
export function pairedFormats(text: string): string | null {
  const doc = parseJupytext(text);
  if (!doc.header) return null;
  const root = parseSimpleYaml(doc.header.lines);
  const jupyter = root["jupyter"];
  if (!jupyter || typeof jupyter !== "object" || Array.isArray(jupyter)) return null;
  const jupytext = (jupyter as Record<string, Json>)["jupytext"];
  if (!jupytext || typeof jupytext !== "object" || Array.isArray(jupytext)) return null;
  const formats = (jupytext as Record<string, Json>)["formats"];
  return typeof formats === "string" ? formats : null;
}

/** A starter notebook: header, one markdown cell, one empty code cell. */
export function newNotebookSource(kernel?: { displayName: string; name: string }): string {
  const header = [
    "jupyter:",
    "  jupytext:",
    "    formats: ipynb,jl:percent",
    "    text_representation:",
    "      extension: .jl",
    "      format_name: percent",
    "      format_version: '1.3'",
  ];
  if (kernel) {
    header.push(
      "  kernelspec:",
      `    display_name: ${kernel.displayName}`,
      "    language: julia",
      `    name: ${kernel.name}`,
    );
  }
  const body = ["# %% [markdown]", ...commentBody("# Untitled"), "", "# %%", ""];
  return `# ---\n${header.map((l) => `# ${l}`).join("\n")}\n# ---\n\n${body.join("\n")}\n`;
}
