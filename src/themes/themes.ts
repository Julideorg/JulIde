import type * as Monaco from "monaco-editor";
import { palettes, bare, mix, type Palette, type PaletteName } from "./tokens";

/**
 * Monaco and xterm themes, derived from `src/themes/tokens.ts`.
 *
 * These used to be hand-written hex literals that happened to match App.css.
 * Nothing enforced the match, so editing a chrome color silently desynced the
 * editor from the app around it. Everything here is now computed from the same
 * palette the stylesheet is generated from.
 */

export interface ThemeDefinition {
  id: string;
  label: string;
  monacoTheme: Monaco.editor.IStandaloneThemeData;
  cssClass: string;
  terminalTheme: Record<string, string>;
}

function monacoTheme(p: Palette, isDark: boolean): Monaco.editor.IStandaloneThemeData {
  const s = p.syntax;
  return {
    base: isDark ? "vs-dark" : "vs",
    inherit: true,
    rules: [
      { token: "keyword", foreground: bare(s.keyword), fontStyle: "bold" },
      // `::` introduces a type annotation, so it reads with the type color.
      { token: "keyword.operator", foreground: bare(s.type) },
      { token: "type.identifier", foreground: bare(s.type) },
      { token: "annotation", foreground: bare(s.macro) },
      { token: "string", foreground: bare(s.string) },
      { token: "string.char", foreground: bare(s.string) },
      { token: "string.symbol", foreground: bare(s.symbol) },
      // `$x` / `$(expr)` is code inside a string — lift it away from the
      // surrounding string color so interpolation is visible at a glance.
      { token: "string.escape", foreground: bare(s.func) },
      { token: "number", foreground: bare(s.number) },
      { token: "number.float", foreground: bare(s.number) },
      { token: "number.hex", foreground: bare(s.number) },
      { token: "number.binary", foreground: bare(s.number) },
      { token: "number.octal", foreground: bare(s.number) },
      { token: "comment", foreground: bare(s.comment), fontStyle: "italic" },
      { token: "operator", foreground: bare(s.operator) },
      { token: "delimiter", foreground: bare(p.fg.mid) },
    ],
    colors: {
      "editor.background": p.surface.canvas,
      "editor.foreground": p.fg.hi,
      "editor.lineHighlightBackground": p.editor.lineHighlight,
      "editor.selectionBackground": p.editor.selection,
      "editor.inactiveSelectionBackground": mix(p.surface.canvas, p.editor.selection, 0.5),
      "editorCursor.foreground": p.mode.brand,
      "editorGutter.background": p.surface.canvas,
      "editorGlyphMargin.background": p.surface.canvas,
      "editorLineNumber.foreground": p.fg.lo,
      "editorLineNumber.activeForeground": p.fg.hi,
      "editorIndentGuide.background": p.hairline.default,
      "editorIndentGuide.activeBackground": p.hairline.strong,
      "editorWhitespace.foreground": p.hairline.strong,
      "editorBracketMatch.background": p.surface.active,
      "editorBracketMatch.border": p.mode.brand,
      "editorError.foreground": p.mode.shell,
      "editorWarning.foreground": p.mode.help,
      "editorInfo.foreground": p.mode.pkg,
      "editorWidget.background": p.surface.raised,
      "editorWidget.border": p.hairline.strong,
      "editorSuggestWidget.background": p.surface.raised,
      "editorSuggestWidget.border": p.hairline.strong,
      "editorSuggestWidget.selectedBackground": p.surface.selected,
      "editorHoverWidget.background": p.surface.raised,
      "editorHoverWidget.border": p.hairline.strong,
      "editorStickyScroll.background": p.surface.panel,
      "editorOverviewRuler.border": p.hairline.default,
      "scrollbarSlider.background": mix(p.surface.active, p.surface.canvas, 0.3),
      "scrollbarSlider.hoverBackground": p.surface.active,
      "scrollbarSlider.activeBackground": p.hairline.strong,
    },
  };
}

/**
 * xterm palette.
 *
 * The ANSI slots are deliberately mapped to the mode colors: Julia's REPL
 * prints `julia>` in ANSI green, `pkg>` in blue, `help?>` in yellow and
 * `shell>` in red, so the live prompt in the terminal ends up exactly the same
 * color as the corresponding mode elsewhere in the UI.
 */
function terminalTheme(p: Palette, isDark: boolean): Record<string, string> {
  const lift = (hex: string) => mix(hex, isDark ? "#ffffff" : "#000000", 0.22);
  return {
    background: p.surface.canvas,
    foreground: p.fg.hi,
    cursor: p.mode.brand,
    cursorAccent: p.surface.canvas,
    selectionBackground: p.editor.selection,

    black: isDark ? p.surface.active : p.fg.hi,
    red: p.mode.shell,
    green: p.mode.run,
    yellow: p.mode.help,
    blue: p.mode.pkg,
    magenta: p.mode.brand,
    cyan: p.syntax.number,
    white: p.fg.mid,

    brightBlack: p.fg.lo,
    brightRed: lift(p.mode.shell),
    brightGreen: lift(p.mode.run),
    brightYellow: lift(p.mode.help),
    brightBlue: lift(p.mode.pkg),
    brightMagenta: lift(p.mode.brand),
    brightCyan: lift(p.syntax.number),
    brightWhite: p.fg.hi,
  };
}

const DEFINITIONS: Record<string, { label: string; palette: PaletteName; cssClass: string }> = {
  "julide-dark": { label: "julIDE Ink", palette: "dark", cssClass: "theme-dark" },
  "julide-light": { label: "julIDE Paper", palette: "light", cssClass: "theme-light" },
};

export const themes: Record<string, ThemeDefinition> = Object.fromEntries(
  Object.entries(DEFINITIONS).map(([id, { label, palette, cssClass }]) => {
    const p = palettes[palette];
    const isDark = palette === "dark";
    return [
      id,
      {
        id,
        label,
        cssClass,
        monacoTheme: monacoTheme(p, isDark),
        terminalTheme: terminalTheme(p, isDark),
      },
    ];
  }),
);

/** Registers every julIDE theme with Monaco. Call once, before the first editor mounts. */
export function defineThemes(monaco: typeof Monaco): void {
  for (const [id, theme] of Object.entries(themes)) {
    monaco.editor.defineTheme(id, theme.monacoTheme);
  }
}
