import { useSettingsStore } from "../stores/useSettingsStore";

/**
 * Plain-ASCII rendering of julIDE's own interface text.
 *
 * Some users read the IDE through a terminal multiplexer, a screen reader, or a font
 * with patchy coverage, and julIDE's typographic punctuation — em dashes, ellipses,
 * middots, arrows, the Mac modifier glyphs — arrives as boxes or as noise. This folds
 * those characters down when `asciiOnly` is on.
 *
 * The table is a **whitelist**, not a transliteration: a character with no entry passes
 * through untouched. That is what makes the fold safe to apply near data — a filename
 * like `José.jl`, a Julia identifier like `∇f`, or a branch name keeps its characters
 * even if the fold is applied by mistake. The rule is still "fold chrome, never data";
 * the whitelist is the seatbelt, not the rule.
 *
 * The editor's ligatures are the other half of the setting and are not handled here —
 * they are a font feature, switched in `MonacoEditor.tsx`.
 */
export const ASCII_FOLD: Record<string, string> = {
  // Prose punctuation. Every em dash in the source is space-surrounded, so a bare `-`
  // lands as ` - ` and needs no context rules.
  "—": "-",
  "–": "-",
  "…": "...",
  "·": "|",
  "→": "->",
  "↔": "<->",
  "⇄": "<->",

  // Glyphs used as ad-hoc icons. The genuinely icon-shaped ones (a refresh arrow, a
  // close cross) became lucide components instead; these are the ones whose CSS is
  // sized and coloured for a text glyph, so they fold rather than move.
  "●": "*",
  "▶": ">",
  "▸": ">",
  "⏸": "||",
  "✕": "x",
  "×": "x",
  "⚠": "!",
  "☑": "[x]",
  "☐": "[ ]",
  "🖼": "[img]",

  // Keyboard modifiers. Each maps to a token ending in `+` and `↵` maps to a terminal
  // one, so chords compose without any joining logic: `⌘⇧P` -> `Cmd+Shift+P`,
  // `⌘↵` -> `Cmd+Enter`, `⌃\`` -> `Ctrl+\``.
  "⌘": "Cmd+",
  "⇧": "Shift+",
  "⌃": "Ctrl+",
  "⌥": "Alt+",
  "↵": "Enter",

  // The two chords the per-character rule gets wrong: `⌘+` would compose to `Cmd++`
  // and `⌘-` to `Cmd+-`. Matched ahead of the single characters.
  "⌘+": "Cmd+Plus",
  "⌘-": "Cmd+Minus",
};

/**
 * Longest key first, so the `⌘+` / `⌘-` entries win over the bare `⌘`.
 *
 * The `u` flag is required rather than cosmetic: `🖼` is U+1F5BC, outside the BMP, and
 * a non-unicode regex would split it into lone surrogates.
 */
const FOLD_PATTERN = new RegExp(
  Object.keys(ASCII_FOLD)
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"),
  "gu",
);

/** The pure core: fold `s` when `on`, otherwise hand it back unchanged. */
export function foldAscii(s: string, on: boolean): string {
  if (!on) return s;
  return s.replace(FOLD_PATTERN, (c) => ASCII_FOLD[c] ?? c);
}

/**
 * Fold against the current setting, read imperatively.
 *
 * For code that has no component to hang a hook on — Monaco decorations and code
 * lenses, the markdown renderer, thrown `Error` messages. Values produced here are not
 * reactive: they are recomputed the next time the surrounding code runs, which for
 * these callers is the next time Monaco asks or the next time the string is thrown.
 */
export function toAscii(s: string): string {
  return foldAscii(s, useSettingsStore.getState().settings.asciiOnly);
}

/**
 * Fold against the current setting, reactively.
 *
 * Returns the identity function when the mode is off, so a component that is not using
 * ASCII mode does no work per string. Subscribing through this hook is also what makes
 * a component re-render when the toggle flips — calling {@link toAscii} inside a
 * component instead would leave that component's text stale until something else
 * re-rendered it.
 */
export function useAscii(): (s: string) => string {
  const on = useSettingsStore((s) => s.settings.asciiOnly);
  return on ? (s: string) => foldAscii(s, true) : identity;
}

const identity = (s: string) => s;
