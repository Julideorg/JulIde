#!/usr/bin/env bun
/**
 * Generates src/components/Editor/latexUnicode.ts from Julia's official
 * latex_symbols.jl and emoji_symbols.jl (v1.12.5).
 *
 * Usage:  bun run scripts/generate-latex-unicode.ts
 */

const JULIA_TAG = "v1.12.5";
const BASE_URL = `https://raw.githubusercontent.com/JuliaLang/julia/${JULIA_TAG}/stdlib/REPL/src`;

async function fetchFile(name: string): Promise<string> {
  const url = `${BASE_URL}/${name}`;
  console.log(`Fetching ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.text();
}

/** Decode Julia string literal escapes (e.g. \uXXXX, \\, \") */
function decodeJuliaString(raw: string): string {
  let result = "";
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "\\" && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === "\\") {
        result += "\\";
        i++;
      } else if (next === '"') {
        result += '"';
        i++;
      } else if (next === "n") {
        result += "\n";
        i++;
      } else if (next === "t") {
        result += "\t";
        i++;
      } else if (next === "u" || next === "U") {
        // \uXXXX or \UXXXXXXXX
        const hexLen = next === "u" ? 4 : 8;
        const hex = raw.slice(i + 2, i + 2 + hexLen);
        const cp = parseInt(hex, 16);
        if (!isNaN(cp)) {
          result += String.fromCodePoint(cp);
          i += 1 + hexLen;
        } else {
          result += raw[i];
        }
      } else {
        result += raw[i];
      }
    } else {
      result += raw[i];
    }
  }
  return result;
}

function parseLatexSymbols(source: string): Map<string, string> {
  const symbols = new Map<string, string>();
  const prefixes = new Map<string, string>();
  const lines = source.split("\n");

  let inLatexDict = false;
  let inCanonicalDict = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect start/end of dicts
    if (trimmed.startsWith("const latex_symbols")) {
      inLatexDict = true;
      continue;
    }
    if (
      trimmed.startsWith("const symbols_latex_canonical") ||
      trimmed.startsWith("symbols_latex_canonical")
    ) {
      inLatexDict = false;
      inCanonicalDict = true;
      continue;
    }

    // Parse prefix variable definitions: const bold = "\\bf"
    const prefixMatch = trimmed.match(/^const\s+(\w+)\s*=\s*"((?:\\.|[^"])*)"$/);
    if (prefixMatch) {
      prefixes.set(prefixMatch[1], decodeJuliaString(prefixMatch[2]));
      continue;
    }

    if (!inLatexDict || inCanonicalDict) continue;

    // Direct entry: "\\command" => "char",  # optional comment
    const directMatch = trimmed.match(
      /^"((?:\\.|[^"])*?)"\s*=>\s*"((?:\\.|[^"])*?)"[,)]?\s*(?:#.*)?$/,
    );
    if (directMatch) {
      const key = decodeJuliaString(directMatch[1]);
      const value = decodeJuliaString(directMatch[2]);
      if (key && value) symbols.set(key, value);
      continue;
    }

    // Concatenated entry: prefix*"suffix" => "char",  # optional comment
    const concatMatch = trimmed.match(
      /^(\w+)\*"((?:\\.|[^"])*?)"\s*=>\s*"((?:\\.|[^"])*?)"[,)]?\s*(?:#.*)?$/,
    );
    if (concatMatch) {
      const prefix = prefixes.get(concatMatch[1]);
      if (prefix) {
        const key = prefix + decodeJuliaString(concatMatch[2]);
        const value = decodeJuliaString(concatMatch[3]);
        if (key && value) symbols.set(key, value);
      }
      continue;
    }
  }

  return symbols;
}

function parseEmojiSymbols(source: string): Map<string, string> {
  const symbols = new Map<string, string>();
  const lines = source.split("\n");

  let inDict = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("const emoji_symbols")) {
      inDict = true;
      continue;
    }

    if (!inDict) continue;

    // Entry: "\\:name:" => "emoji",
    const match = trimmed.match(/^"((?:\\.|[^"])*?)"\s*=>\s*"((?:\\.|[^"])*?)"[,)]?\s*$/);
    if (match) {
      const key = decodeJuliaString(match[1]);
      const value = decodeJuliaString(match[2]);
      if (key && value) symbols.set(key, value);
    }
  }

  return symbols;
}

/** Escape a string for use as a JS string literal (double-quoted) */
function escapeForJS(s: string): string {
  let result = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\\") result += "\\\\";
    else if (ch === '"') result += '\\"';
    else if (ch === "\n") result += "\\n";
    else if (ch === "\t") result += "\\t";
    else if (cp < 0x20) result += `\\u${cp.toString(16).padStart(4, "0")}`;
    else result += ch;
  }
  return result;
}

async function main() {
  const [latexSource, emojiSource] = await Promise.all([
    fetchFile("latex_symbols.jl"),
    fetchFile("emoji_symbols.jl"),
  ]);

  const latexSymbols = parseLatexSymbols(latexSource);
  const emojiSymbols = parseEmojiSymbols(emojiSource);

  console.log(`Parsed ${latexSymbols.size} LaTeX symbols`);
  console.log(`Parsed ${emojiSymbols.size} emoji symbols`);

  // Merge: latex takes precedence over emoji for duplicate keys
  const merged = new Map<string, string>();
  for (const [k, v] of latexSymbols) merged.set(k, v);
  for (const [k, v] of emojiSymbols) {
    if (!merged.has(k)) merged.set(k, v);
  }

  console.log(`Total merged symbols: ${merged.size}`);

  // Generate TypeScript
  const lines: string[] = [];
  lines.push(`// AUTO-GENERATED from Julia ${JULIA_TAG} — do not edit by hand`);
  lines.push(`// Source: stdlib/REPL/src/latex_symbols.jl + emoji_symbols.jl`);
  lines.push(`// Generated: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(
    `// LaTeX: ${latexSymbols.size} | Emoji: ${emojiSymbols.size} | Total: ${merged.size}`,
  );
  lines.push(``);
  lines.push(`export const LATEX_UNICODE: Record<string, string> = {`);

  // Sort entries for deterministic output
  const sortedEntries = [...merged.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [key, value] of sortedEntries) {
    lines.push(`  "${escapeForJS(key)}": "${escapeForJS(value)}",`);
  }

  lines.push(`};`);
  lines.push(``);

  const outPath = new URL("../src/components/Editor/latexUnicode.ts", import.meta.url).pathname;
  await Bun.write(outPath, lines.join("\n"));
  console.log(`Written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
