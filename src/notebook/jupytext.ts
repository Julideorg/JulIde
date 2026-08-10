/**
 * The jupytext **percent** format, for Julia scripts.
 *
 * A `.jl` file with `# %%` markers *is* a notebook — that is jupytext's whole premise,
 * and it is why julIDE layers cells over the ordinary editor rather than replacing it.
 * The file text stays the single source of truth, so the language server, autosave, git
 * diff and undo all keep working with no notebook-shaped machinery underneath them.
 *
 * Pure and DOM-free on purpose: no `monaco-editor` import, not even a type one, so this
 * module is fully testable under `bun test` and safe to pull into any context.
 *
 * ## Byte-exact round trips, and why the raw fields exist
 *
 * `serialize(parse(text)) === text` has to hold for *every* input, or a targeted edit to
 * one cell would silently reformat the rest of the file. It cannot hold from the parsed
 * view alone, because parsing is lossy in both directions:
 *
 *  - Uncommenting is not injective. jupytext's rule is "strip `# ` if present, else `#`
 *    if present, else leave the line alone" — so a markdown body line that never had a
 *    comment marker survives uncommenting unchanged and then *gains* one on the way back.
 *  - `# %% ` with a trailing space, `#%%`, and `#  %%` all mean the same cell and would
 *    all normalise to `# %%`.
 *
 * So every cell keeps `rawMarker` and `rawBody` verbatim, and the serializer re-derives
 * text only for cells someone actually mutated (`dirty`). Untouched cells are emitted
 * byte for byte.
 *
 * Rules below were taken from jupytext's `cell_reader.py`, `cell_to_text.py`,
 * `cell_metadata.py` and `header.py` rather than from memory.
 */

export type CellType = "code" | "markdown" | "raw";

export interface JupytextCell {
  type: CellType;
  /** Body with comment-escaping removed (markdown/raw) or verbatim (code), trimmed. */
  source: string;
  /** Free text on the marker line, e.g. `# %% Load the data`. */
  title?: string;
  /** `key=value` pairs from the marker line, in source order. */
  metadata: Record<string, string>;
  /** Extra `%` for Spyder sub-cells: `# %%%` is 1. */
  cellDepth: number;
  /** `md` when the marker said `[md]`, so it round-trips as `[md]` and not `[markdown]`. */
  regionName?: "md";
  /** Marker tail that could not be parsed. Kept verbatim rather than dropped. */
  unparsedMetadata?: string;

  /** The marker line verbatim; null for an implicit leading cell. */
  rawMarker: string | null;
  /** Every line after the marker up to the next one, verbatim, trailing blanks included. */
  rawBody: string[];
  /** Set by the mutation helpers. The serializer re-derives text only when true. */
  dirty: boolean;

  /** No marker at all: the cell before the first `# %%`. */
  implicit: boolean;
  /** Introduced by a legacy `##` line rather than `# %%`. */
  legacy: boolean;

  /** 1-based inclusive. `markerLine` is 0 for an implicit cell. */
  range: { markerLine: number; startLine: number; endLine: number };
}

export interface JupytextHeader {
  /** Lines strictly between the `---` fences, uncommented and verbatim. */
  lines: string[];
  /** Shebang / coding cookie ahead of the fence, verbatim and still commented. */
  preamble: string[];
  /** 1-based inclusive span of the whole `# ---` … `# ---` block. */
  range: { startLine: number; endLine: number };
  /** Blank lines between the closing fence and the first cell. */
  blanksAfter: number;
}

/** `percent` once a marker or a jupytext header is present; `legacy` for julIDE's `##`. */
export type Dialect = "percent" | "legacy" | "none";

export interface JupytextDocument {
  header: JupytextHeader | null;
  cells: JupytextCell[];
  eol: "\n" | "\r\n";
  /** Preserved so a file without one does not silently gain one. */
  endsWithNewline: boolean;
  dialect: Dialect;
}

/* ── Regexes, matching jupytext's own ─────────────────────────────────────── */

/**
 * `# %%`, `#%%`, `  # %%% Title [markdown] key="v"`.
 *
 * The `\s` after `%%(%*)` is **mandatory** in jupytext, which has a consequence people
 * get wrong: `# %%[markdown]` is not a marker at all. Group 1 is the Spyder sub-cell
 * depth, group 2 is everything else on the line.
 */
const PERCENT_MARKER = /^\s*#\s*%%(%*)\s(.*)$/;

/** A marker with nothing after it, plus the nbconvert spellings jupytext also accepts. */
const PERCENT_MARKER_BARE = /^\s*#\s*(%%|<codecell>|In\[[0-9 ]*\]:?)\s*$/;

/** julIDE's pre-existing separator, from before any of this existed. */
const LEGACY_MARKER = /^\s*##/;

/** Applied to the *uncommented* line. */
const HEADER_FENCE = /^---\s*$/;
const SHEBANG = /^#!/;
const CODING_COOKIE = /^[ \t\f]*#.*?coding[:=][ \t]*[-_.a-zA-Z0-9]+/;

/** `[markdown]`, `[md]` or `[raw]`, which jupytext accepts anywhere inside the title. */
const CELL_TYPE_TAG = /\[(markdown|md|raw)\]/;

/* ── Comment escaping ─────────────────────────────────────────────────────── */

/** `text` → `# text`, and an empty line → a bare `#`. jupytext's `comment_lines`. */
export function commentBody(source: string): string[] {
  return source.split("\n").map((line) => (line.length === 0 ? "#" : `# ${line}`));
}

/**
 * The inverse, as far as it goes.
 *
 * Strip `# ` if present, else `#` if present, else leave the line untouched — the
 * asymmetry that makes this non-injective, and the reason `rawBody` exists.
 */
export function uncommentBody(lines: string[]): string {
  return lines
    .map((line) => {
      if (line.startsWith("# ")) return line.slice(2);
      if (line.startsWith("#")) return line.slice(1);
      return line;
    })
    .join("\n");
}

/* ── Marker parsing ───────────────────────────────────────────────────────── */

export interface ParsedMarker {
  type: CellType;
  title?: string;
  metadata: Record<string, string>;
  cellDepth: number;
  regionName?: "md";
  unparsedMetadata?: string;
}

/**
 * Split a marker's options into a title and `key=value` pairs.
 *
 * jupytext takes words left to right up to (exclusive) the word containing the first
 * `=`; everything from there is metadata.
 */
function splitTitleAndMetadata(options: string): {
  title: string;
  metadata: Record<string, string>;
  unparsed?: string;
} {
  const trimmed = options.trim();
  if (!trimmed) return { title: "", metadata: {} };

  const eq = trimmed.indexOf("=");
  if (eq === -1) return { title: trimmed, metadata: {} };

  // Walk back from the `=` to the start of the word holding it.
  let wordStart = eq;
  while (wordStart > 0 && !/\s/.test(trimmed[wordStart - 1])) wordStart -= 1;

  const title = trimmed.slice(0, wordStart).trim();
  const rest = trimmed.slice(wordStart).trim();

  const metadata: Record<string, string> = {};
  // key=value, key="quoted value", key=["a","b"]
  const pair = /([a-zA-Z0-9_.@/-]+)=("(?:[^"\\]|\\.)*"|\[[^\]]*\]|\{[^}]*\}|\S+)/g;
  let consumed = 0;
  let m: RegExpExecArray | null;
  while ((m = pair.exec(rest)) !== null) {
    metadata[m[1]] = m[2];
    consumed = m.index + m[0].length;
  }
  const leftover = rest.slice(consumed).trim();
  return leftover ? { title, metadata, unparsed: leftover } : { title, metadata };
}

/** Parse one `# %%` line, or return null when it is not a marker at all. */
export function parseMarkerLine(line: string): ParsedMarker | null {
  if (PERCENT_MARKER_BARE.test(line)) {
    return { type: "code", metadata: {}, cellDepth: 0 };
  }
  const m = PERCENT_MARKER.exec(line);
  if (!m) return null;

  const cellDepth = m[1].length;
  let options = m[2];

  let type: CellType = "code";
  let regionName: "md" | undefined;
  const tag = CELL_TYPE_TAG.exec(options);
  if (tag) {
    if (tag[1] === "raw") type = "raw";
    else {
      type = "markdown";
      if (tag[1] === "md") regionName = "md";
    }
    options = options.slice(0, tag.index) + options.slice(tag.index + tag[0].length);
  }

  const { title, metadata, unparsed } = splitTitleAndMetadata(options);
  return {
    type,
    ...(title ? { title } : {}),
    metadata,
    cellDepth,
    ...(regionName ? { regionName } : {}),
    ...(unparsed ? { unparsedMetadata: unparsed } : {}),
  };
}

/** Build a canonical marker line: title first, then `[type]`, then metadata. */
export function formatMarkerLine(cell: JupytextCell): string {
  const parts: string[] = [`# %%${"%".repeat(cell.cellDepth)}`];
  if (cell.title) parts.push(cell.title);
  if (cell.type === "markdown") parts.push(cell.regionName === "md" ? "[md]" : "[markdown]");
  else if (cell.type === "raw") parts.push("[raw]");
  for (const [k, v] of Object.entries(cell.metadata)) parts.push(`${k}=${v}`);
  if (cell.unparsedMetadata) parts.push(cell.unparsedMetadata);
  return parts.join(" ");
}

/* ── String-aware marker scanning ─────────────────────────────────────────── */

/**
 * Which lines are cell markers, skipping Julia strings and block comments.
 *
 * Needed because julIDE's original scanner did a plain `startsWith("##")`, so a
 * docstring containing a `## Examples` heading split the cell in two. Julia's `#= =#`
 * block comments nest, hence the depth counter rather than a boolean.
 */
function findMarkerLines(lines: string[], from: number): Set<number> {
  const markers = new Set<number>();
  let inTripleString = false;
  let blockDepth = 0;

  for (let i = from; i < lines.length; i++) {
    const line = lines[i];

    if (!inTripleString && blockDepth === 0) {
      if (PERCENT_MARKER.test(line) || PERCENT_MARKER_BARE.test(line) || LEGACY_MARKER.test(line)) {
        markers.add(i);
        continue;
      }
    }

    // Advance the string/comment state across this line.
    for (let c = 0; c < line.length; c++) {
      if (inTripleString) {
        if (line.startsWith('"""', c)) {
          inTripleString = false;
          c += 2;
        }
        continue;
      }
      if (blockDepth > 0) {
        if (line.startsWith("#=", c)) {
          blockDepth += 1;
          c += 1;
        } else if (line.startsWith("=#", c)) {
          blockDepth -= 1;
          c += 1;
        }
        continue;
      }
      if (line.startsWith('"""', c)) {
        inTripleString = true;
        c += 2;
      } else if (line.startsWith("#=", c)) {
        blockDepth += 1;
        c += 1;
      } else if (line[c] === "#") {
        // A line comment: nothing after it can open a string or block comment.
        break;
      } else if (line[c] === "\\") {
        c += 1;
      } else if (line[c] === '"') {
        // Skip a single-quoted string so a `#` inside it is not treated as a comment.
        c += 1;
        while (c < line.length && line[c] !== '"') {
          if (line[c] === "\\") c += 1;
          c += 1;
        }
      }
    }
  }
  return markers;
}

/* ── Parsing ──────────────────────────────────────────────────────────────── */

function parseHeader(lines: string[]): JupytextHeader | null {
  let i = 0;
  const preamble: string[] = [];
  while (i < lines.length && (SHEBANG.test(lines[i]) || CODING_COOKIE.test(lines[i]))) {
    preamble.push(lines[i]);
    i += 1;
  }

  const start = i;
  if (i >= lines.length || !lines[i].startsWith("#")) return null;
  if (!HEADER_FENCE.test(uncommentBody([lines[i]]))) return null;

  i += 1;
  const body: string[] = [];
  while (i < lines.length && lines[i].startsWith("#")) {
    const text = uncommentBody([lines[i]]);
    if (HEADER_FENCE.test(text)) {
      const end = i;
      let blanks = 0;
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") {
        blanks += 1;
        j += 1;
      }
      return {
        lines: body,
        preamble,
        range: { startLine: start + 1, endLine: end + 1 },
        blanksAfter: blanks,
      };
    }
    body.push(text);
    i += 1;
  }
  // Unterminated fence — not a header.
  return null;
}

export function detectDialect(text: string): Dialect {
  const lines = text.split(/\r?\n/);
  const header = parseHeader(lines);
  if (header && header.lines.some((l) => /^\s*jupytext\s*:/.test(l))) return "percent";
  const markers = findMarkerLines(lines, header ? header.range.endLine : 0);
  for (const i of markers) {
    if (PERCENT_MARKER.test(lines[i]) || PERCENT_MARKER_BARE.test(lines[i])) return "percent";
  }
  return markers.size > 0 ? "legacy" : "none";
}

/** True when julIDE should offer notebook affordances for this file. */
export function isNotebookSource(text: string): boolean {
  return detectDialect(text) === "percent";
}

export function parseJupytext(text: string): JupytextDocument {
  const eol: "\n" | "\r\n" = text.includes("\r\n") ? "\r\n" : "\n";
  const endsWithNewline = text.endsWith("\n");
  // A trailing newline produces a final empty element that is not a real line.
  const raw = text.split(/\r?\n/);
  const lines = endsWithNewline ? raw.slice(0, -1) : raw;

  const header = parseHeader(lines);
  const bodyStart = header ? header.range.endLine + header.blanksAfter : 0;
  const dialect = detectDialect(text);

  // `##` splits cells only in a legacy file. In a percent notebook a `## TODO` comment
  // inside a code cell must not split it.
  const allMarkers = findMarkerLines(lines, bodyStart);
  const markers: number[] = [];
  for (const i of [...allMarkers].sort((a, b) => a - b)) {
    const isPercent = PERCENT_MARKER.test(lines[i]) || PERCENT_MARKER_BARE.test(lines[i]);
    if (isPercent || dialect === "legacy") markers.push(i);
  }

  const cells: JupytextCell[] = [];

  const push = (markerIndex: number | null, bodyFrom: number, bodyTo: number) => {
    const rawBody = lines.slice(bodyFrom, bodyTo);
    const markerLine = markerIndex === null ? null : lines[markerIndex];
    const parsed = markerLine === null ? null : parseMarkerLine(markerLine);
    const legacy = markerLine !== null && parsed === null;

    // Trailing blank lines belong to the separation between cells, not to the source.
    const trimmed = [...rawBody];
    while (trimmed.length > 0 && trimmed[trimmed.length - 1].trim() === "") trimmed.pop();

    const type = parsed?.type ?? "code";
    const source = type === "code" ? trimmed.join("\n") : uncommentBody(trimmed);

    cells.push({
      type,
      source,
      ...(parsed?.title ? { title: parsed.title } : {}),
      metadata: parsed?.metadata ?? {},
      cellDepth: parsed?.cellDepth ?? 0,
      ...(parsed?.regionName ? { regionName: parsed.regionName } : {}),
      ...(parsed?.unparsedMetadata ? { unparsedMetadata: parsed.unparsedMetadata } : {}),
      rawMarker: markerLine,
      rawBody,
      dirty: false,
      implicit: markerIndex === null,
      legacy,
      range: {
        markerLine: markerIndex === null ? 0 : markerIndex + 1,
        startLine: bodyFrom + 1,
        endLine: bodyTo,
      },
    });
  };

  if (markers.length === 0) {
    // No markers at all: the whole body is one implicit code cell, unless it is empty.
    if (lines.slice(bodyStart).some((l) => l.trim() !== "")) {
      push(null, bodyStart, lines.length);
    }
  } else {
    if (markers[0] > bodyStart && lines.slice(bodyStart, markers[0]).some((l) => l.trim() !== "")) {
      push(null, bodyStart, markers[0]);
    }
    for (let k = 0; k < markers.length; k++) {
      const from = markers[k] + 1;
      const to = k + 1 < markers.length ? markers[k + 1] : lines.length;
      push(markers[k], from, to);
    }
  }

  return { header, cells, eol, endsWithNewline, dialect };
}

/* ── Serialization ────────────────────────────────────────────────────────── */

function serializeCell(cell: JupytextCell, isLast: boolean): string[] {
  if (!cell.dirty) {
    // Byte-exact: this is the path every untouched cell takes. Any blank lines that
    // separated it from the next cell are already sitting in rawBody.
    return cell.rawMarker === null ? [...cell.rawBody] : [cell.rawMarker, ...cell.rawBody];
  }

  const body = cell.type === "code" ? cell.source.split("\n") : commentBody(cell.source);
  const marker = cell.implicit ? [] : [formatMarkerLine(cell)];
  // jupytext's `pep8_lines_between_cells` returns 1 for every non-Python extension, so
  // the canonical spacing is one blank line *between* cells. The last cell gets none —
  // the document's own trailing newline is handled by the caller.
  return isLast ? [...marker, ...body] : [...marker, ...body, ""];
}

export function serializeJupytext(doc: JupytextDocument): string {
  const lines: string[] = [];

  if (doc.header) {
    lines.push(...doc.header.preamble);
    lines.push("# ---");
    for (const line of doc.header.lines) lines.push(line.length === 0 ? "#" : `# ${line}`);
    lines.push("# ---");
    for (let i = 0; i < doc.header.blanksAfter; i++) lines.push("");
  }

  doc.cells.forEach((cell, i) => lines.push(...serializeCell(cell, i === doc.cells.length - 1)));

  const text = lines.join(doc.eol);
  return doc.endsWithNewline ? text + doc.eol : text;
}

/* ── Lookups the editor needs ─────────────────────────────────────────────── */

/** Index of the cell containing a 1-based line, or -1. */
export function cellIndexAtLine(doc: JupytextDocument, line: number): number {
  for (let i = 0; i < doc.cells.length; i++) {
    const c = doc.cells[i];
    const from = c.implicit ? c.range.startLine : c.range.markerLine;
    if (line >= from && line <= Math.max(c.range.endLine, from)) return i;
  }
  return doc.cells.length > 0 ? doc.cells.length - 1 : -1;
}

/**
 * The body range of the cell containing a line, matching the old `getCellRange`
 * contract: 1-based inclusive, marker line excluded.
 */
export function cellRangeAtLine(
  doc: JupytextDocument,
  line: number,
): { startLine: number; endLine: number } {
  const i = cellIndexAtLine(doc, line);
  if (i === -1) return { startLine: 1, endLine: 1 };
  const c = doc.cells[i];
  return { startLine: c.range.startLine, endLine: Math.max(c.range.startLine, c.range.endLine) };
}
