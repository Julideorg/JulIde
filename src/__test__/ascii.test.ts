import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { ASCII_FOLD } from "../services/ascii";
import { defaultSettings } from "../stores/useSettingsStore";

/**
 * Guards for ASCII-only mode.
 *
 * The mode works by folding julIDE's own text at render time, so the Unicode stays in
 * the source and a plain character count can never tell you whether it is handled.
 * What these tests check instead is *coverage*: every non-ASCII character in a shipped
 * string literal must have a fold defined for it, and must either sit inside a fold call
 * or be listed below with the reason it is folded somewhere else.
 *
 * Comments are excluded by construction. That matters more than it sounds: the codebase
 * carries over twelve thousand `─` characters in comment section separators, and any
 * line-prefix regex that tried to skip them would also mishandle JSDoc and the em dashes
 * inside `{/* ... *\/}` blocks in JSX.
 */

const SRC = join(import.meta.dir, "..");
// eslint-disable-next-line no-control-regex -- the point is the ASCII range itself
const NON_ASCII = /[^\x00-\x7F]/u;
const FOLD_CALLS = new Set(["ascii", "toAscii", "foldAscii"]);

/**
 * Files whose literals are deliberately left un-folded in place.
 *
 * The number is how many such literals the file is expected to hold, so adding one more
 * fails here rather than shipping an un-folded glyph. Each entry names where the fold
 * actually happens.
 */
const FOLDED_ELSEWHERE: Record<string, number> = {
  // The fold table itself.
  "services/ascii.ts": 24,
  // 16 `shortcut:` fields reach the screen only via `modes.ts` -> the ModeBar `hint`
  // render, which folds. `:245` is a bottom-panel badge the App.tsx render excludes for
  // the debug panel, and `:969` is a toast, folded in Toast.tsx.
  "services/builtinContributions.ts": 17,
  // Dead module: `DEFAULT_KEYBINDINGS` and `getKeybindingLabel` are imported by nothing
  // but their own test, so these labels never render.
  "services/keybindings.ts": 9,
  // Mode hints, placeholders and descriptions, all folded in ModeBar.tsx.
  "components/ModeBar/modes.ts": 5,
  // STRATEGIES labels, folded where they are mapped into <Select options>.
  "components/BestieTemplateDialog/BestieTemplateDialog.tsx": 4,
  // EmptyState title and hint, folded in Panel.tsx.
  "components/Settings/PluginBrowser.tsx": 2,
  // Returned by shortcutLabel(); both callers fold the result.
  "components/ModeBar/ModeBar.tsx": 1,
  // Thrown into the store's `error`, which the dialog folds when it renders it.
  "components/Welcome/JuliaSetupDialog.tsx": 1,
  // <Kbd>, folded in Panel.tsx.
  "components/Welcome/WelcomeScreen.tsx": 1,
  // The default `placeholder`, folded in this component's own render.
  "components/ui/Select.tsx": 1,
  // PERMISSION_CATALOG wording, folded in PluginPermissionTable.tsx. Left alone here
  // because these literals are mirrored into the generated permission-catalog.json.
  "services/pluginPermissions.ts": 1,
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "__test__") out.push(...sourceFiles(p));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    // Generated Julia symbol data, the Julia grammar's own operators, and fixtures.
    if (/latexUnicode|juliaLanguage|\.test\.|\.stories\./.test(p)) continue;
    out.push(p);
  }
  return out;
}

/** Nodes that hold text somebody wrote, as opposed to code or comments. */
type AuthoredText =
  ts.StringLiteralLike | ts.TemplateHead | ts.TemplateMiddle | ts.TemplateTail | ts.JsxText;

function isAuthoredText(n: ts.Node): n is AuthoredText {
  return (
    ts.isStringLiteralLike(n) ||
    ts.isTemplateHead(n) ||
    ts.isTemplateMiddle(n) ||
    ts.isTemplateTail(n) ||
    ts.isJsxText(n)
  );
}

/** True when some ancestor is a call to ascii() / toAscii() / foldAscii(). */
function insideFoldCall(node: ts.Node): boolean {
  for (let n = node.parent; n; n = n.parent) {
    if (!ts.isCallExpression(n)) continue;
    const callee = n.expression;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : "";
    if (FOLD_CALLS.has(name)) return true;
  }
  return false;
}

interface Hit {
  file: string;
  text: string;
  covered: boolean;
}

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const file of sourceFiles(SRC)) {
    const sf = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (n: ts.Node) => {
      if (isAuthoredText(n) && NON_ASCII.test(n.text)) {
        hits.push({ file: relative(SRC, file), text: n.text, covered: insideFoldCall(n) });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return hits;
}

describe("ASCII-only mode", () => {
  test("every non-ASCII character in UI text has a fold defined", () => {
    // Otherwise the mode silently passes the character straight through, which is the
    // one failure the user would actually see.
    const unmapped: Record<string, string[]> = {};
    for (const hit of scan()) {
      for (const ch of [...hit.text]) {
        if (!NON_ASCII.test(ch) || ch in ASCII_FOLD) continue;
        (unmapped[hit.file] ??= []).push(ch);
      }
    }
    expect(unmapped).toEqual({});
  });

  test("every fold produces ASCII", () => {
    const bad = Object.entries(ASCII_FOLD).filter(([, to]) => NON_ASCII.test(to));
    expect(bad).toEqual([]);
  });

  test("un-folded literals are only the ones folded elsewhere", () => {
    // Adding a new `—` to a label fails here until it is either wrapped in a fold call
    // or added above with the reason it does not need one.
    const counts: Record<string, number> = {};
    for (const hit of scan()) {
      if (hit.covered) continue;
      counts[hit.file] = (counts[hit.file] ?? 0) + 1;
    }
    expect(counts).toEqual(FOLDED_ELSEWHERE);
  });

  test("every CSS content glyph has an .ascii override", () => {
    // CSS-drawn glyphs are unreachable from any fold, so the root class is the only
    // mechanism. A `content:` with a non-ASCII glyph and no override would be stranded.
    const dir = join(SRC, "styles");
    const stranded: Record<string, string[]> = {};
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".css"))) {
      const css = readFileSync(join(dir, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      const glyphs = [...css.matchAll(/content:\s*"([^"]*)"/g)]
        .map((m) => m[1])
        .filter((v) => NON_ASCII.test(v));
      if (!glyphs.length) continue;
      // One `.ascii ` override per distinct glyph rule is the invariant we can check
      // cheaply: at least as many overrides as glyph declarations.
      const overrides = (css.match(/\.ascii\s/g) ?? []).length;
      if (overrides < glyphs.length) stranded[name] = glyphs;
    }
    expect(stranded).toEqual({});
  });

  test("the Rust Settings struct mirrors the TypeScript one", () => {
    // Generalises the activityBarLabels bug: settings_save serialises the whole Rust
    // struct, so a field that exists only on the TypeScript side is dropped on every
    // write and its toggle resets itself on restart.
    const rust = readFileSync(join(SRC, "..", "src-tauri", "src", "settings.rs"), "utf8");
    const structBody = rust.slice(
      rust.indexOf("pub struct Settings {"),
      rust.indexOf("fn default_font_size"),
    );
    const rustKeys = [...structBody.matchAll(/^\s{4}pub (\w+):/gm)]
      .map((m) => m[1].replace(/_(\w)/g, (_, c) => c.toUpperCase()))
      .sort();
    expect(rustKeys).toEqual(Object.keys(defaultSettings).sort());
  });
});
