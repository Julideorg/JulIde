import type { TokenizerAndRendererExtension, Tokens } from "marked";
import { escapeHtml } from "./sanitize";

/**
 * TeX delimiters for the markdown preview.
 *
 * These extensions do **not** render anything. They turn `$…$` into an inert placeholder
 * whose text content is the TeX source; `useMarkdownMath` typesets it after the document
 * has been sanitized, the same way `useMarkdownImages` attaches an `<img>` after the fact.
 *
 * That split is what keeps sanitize.ts untouched. KaTeX emits spans carrying inline
 * `style` plus a `<math>` subtree, and `style` is in FORBID_ATTR while `math` is in
 * FORBID_TAGS — typesetting *before* the sanitizer would mean relaxing both, for every
 * document, in order to render maths in some of them.
 *
 * The TeX rides as the placeholder's text content rather than a `data-` attribute because
 * ALLOW_DATA_ATTR is false: a second `data-md-*` would have to be added to the allowlist,
 * where a text node passes through as-is. It also degrades honestly — when KaTeX cannot
 * be loaded, what stays on screen is the source the author wrote.
 *
 * This module deliberately imports no KaTeX. It is unit-tested under `bun test`, which has
 * no DOM, and the parsing rules below are the part worth testing without one.
 */

/** Class shared by every placeholder, inline or display. The hook queries on it. */
const MATH_CLASS = "md-math";
const DISPLAY_CLASS = "md-math md-math--display";

interface MathToken extends Tokens.Generic {
  type: "mathBlock" | "mathInline";
  text: string;
  display: boolean;
}

/**
 * Display maths standing alone: `$$…$$` or `\[…\]` as its own block.
 *
 * Block level rather than inline so the result is not wrapped in a `<p>`, which would
 * make a centred equation inherit paragraph margins and line-height.
 */
const mathBlock: TokenizerAndRendererExtension = {
  name: "mathBlock",
  level: "block",

  start(src: string) {
    return src.match(/^ {0,3}(?:\$\$|\\\[)/m)?.index;
  },

  tokenizer(src: string) {
    const match = /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n+|$)/.exec(src);
    if (!match) return undefined;
    const text = (match[1] ?? match[2]).trim();
    if (!text) return undefined;
    // `raw` must cover the trailing blank lines too, or the block lexer re-reads them.
    return { type: "mathBlock", raw: match[0], text, display: true } satisfies MathToken;
  },

  renderer(token) {
    return `<div class="${DISPLAY_CLASS}">${escapeHtml((token as MathToken).text)}</div>\n`;
  },
};

/**
 * Maths inside a line of prose: `$…$`, `\(…\)`, and `$$…$$` when it did not get a block
 * of its own.
 *
 * The `$` rule is the one that needs care, because `$` is also a currency symbol. It
 * requires a non-space immediately inside both delimiters and refuses a digit straight
 * after the closing one, which is the convention Jupyter and GitHub settled on:
 *
 *   `$E = mc^2$`             → maths
 *   `costs $5 and $10`       → literal, because "5 and " ends in a space
 *   `\$5`                    → literal, handled by marked's own escape rule: this
 *                              tokenizer anchors on `$` and declines at the backslash
 *
 * Content may not span a newline either — a stray `$` two paragraphs down should not
 * silently swallow everything in between.
 *
 * Code spans need no special handling. At `` `$x$` `` the scan position is the backtick,
 * so this tokenizer declines and marked's `codespan` rule takes the whole run; fenced
 * blocks are resolved by the block lexer before inline tokenizing starts.
 */
const mathInline: TokenizerAndRendererExtension = {
  name: "mathInline",
  level: "inline",

  start(src: string) {
    return src.match(/\$|\\\(/)?.index;
  },

  tokenizer(src: string) {
    // `$$` first: otherwise the `$` rule below claims the opening pair and leaves a
    // dangling delimiter behind.
    const display = /^\$\$([^\n]+?)\$\$/.exec(src);
    if (display) {
      const text = display[1].trim();
      if (text) {
        return { type: "mathInline", raw: display[0], text, display: true } satisfies MathToken;
      }
    }

    const paren = /^\\\(([\s\S]+?)\\\)/.exec(src);
    if (paren) {
      const text = paren[1].trim();
      if (text) {
        return { type: "mathInline", raw: paren[0], text, display: false } satisfies MathToken;
      }
    }

    const dollar = /^\$([^\s$](?:[^$\n]*[^\s$])?)\$(?!\d)/.exec(src);
    if (dollar) {
      return {
        type: "mathInline",
        raw: dollar[0],
        text: dollar[1].trim(),
        display: false,
      } satisfies MathToken;
    }

    return undefined;
  },

  renderer(token) {
    const { text, display } = token as MathToken;
    return `<span class="${display ? DISPLAY_CLASS : MATH_CLASS}">${escapeHtml(text)}</span>`;
  },
};

export const mathExtensions = [mathBlock, mathInline];
