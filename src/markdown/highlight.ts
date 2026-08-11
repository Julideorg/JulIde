import DOMPurify from "dompurify";
import { isSanitizerAvailable } from "./sanitize";

/**
 * Support for highlighting fenced code in the markdown preview.
 *
 * The highlighter is Monaco, not a second library. It already ships in the bundle, the
 * Julia Monarch grammar is already registered (src/components/Editor/juliaLanguage.ts),
 * and `monaco.editor.colorize` paints with the *active* julIDE theme — so a fence in a
 * README comes out matching the editor two panes over, for free, and every other grammar
 * Monaco carries comes along with it. A highlight.js or Shiki would have meant a second
 * grammar for Julia and a second theme to keep in step with the first.
 *
 * The monaco import itself lives in useMarkdownHighlight.ts rather than here: this module
 * is unit-tested under `bun test`, which cannot load the editor.
 */

/** The shape of `monaco.languages.getLanguages()`, narrowed to what the index needs. */
export interface LanguageDescriptor {
  id: string;
  aliases?: string[] | null;
  extensions?: string[] | null;
}

/**
 * Fence tag → Monaco language id.
 *
 * Built from Monaco's own registry rather than a hand-written table, so it covers every
 * grammar the editor ships and cannot drift from it. Aliases and extensions are folded in
 * because fences are written the short way — ` ```jl `, ` ```py `, ` ```sh ` — while
 * Monaco's ids are the long ones.
 *
 * Precedence is deliberate: extensions first, then aliases, then ids last, so a real
 * language id always wins a collision. Several grammars claim `.h`, and Julia is
 * registered twice (once by Monaco's basic-languages, once by julIDE's own Monarch
 * definition) — with ids applied last, `julia` resolves to `julia` either way.
 */
export function buildLanguageIndex(languages: readonly LanguageDescriptor[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const lang of languages) {
    for (const ext of lang.extensions ?? []) {
      index.set(ext.replace(/^\./, "").toLowerCase(), lang.id);
    }
  }
  for (const lang of languages) {
    for (const alias of lang.aliases ?? []) index.set(alias.toLowerCase(), lang.id);
  }
  for (const lang of languages) index.set(lang.id.toLowerCase(), lang.id);
  return index;
}

/**
 * Pull the fence tag out of the class marked put there.
 *
 * `renderer.ts` leaves marked's default `code` renderer alone, so a fence arrives as
 * `<code class="language-julia">` — the class survives sanitization, and this is the
 * "highlighted later" that renderer.test.ts has been describing since the preview landed.
 */
export function fenceLanguage(className: string): string | null {
  return /(?:^|\s)language-([\w+#.-]+)/.exec(className)?.[1]?.toLowerCase() ?? null;
}

/**
 * Colorized markup is `<span class="mtk7">` runs joined by `<br/>`, and the colours come
 * from global `.mtkN` rules Monaco keeps in step with the active theme. So the allowlist
 * needs two tags and one attribute, and notably **not** `style` — nothing here has to
 * relax what the markdown sanitizer forbids.
 */
const CONFIG = {
  ALLOWED_TAGS: ["span", "br"],
  ALLOWED_ATTR: ["class"],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

/**
 * Sanitize colorized markup, or fail closed with `null`.
 *
 * Monaco escapes the text it colorizes, so this is defense in depth rather than the only
 * wall — the same posture sanitize.ts takes towards marked. `null` means the caller must
 * leave the plain text alone: the one thing that must never happen is unsanitized markup
 * reaching `innerHTML` because the sanitizer quietly wasn't there.
 */
export function sanitizeColorized(html: string): string | null {
  if (!isSanitizerAvailable()) return null;
  // Monaco appends a <br/> after every line including the last, which would show as a
  // blank final line in a <pre> that already breaks on newlines.
  return DOMPurify.sanitize(html.replace(/<br\/?>$/, ""), CONFIG);
}
