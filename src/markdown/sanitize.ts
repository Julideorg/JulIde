import DOMPurify from "dompurify";

/**
 * The sanitizer standing between a markdown file and `dangerouslySetInnerHTML`.
 *
 * It is the second of three layers, not the only one:
 *  1. `renderer.ts` runs marked with raw-HTML passthrough **off**, so authored `<script>`
 *     never becomes markup in the first place — it comes out as escaped text.
 *  2. This allowlist, which keeps the output to prose and tables.
 *  3. The CSP in src-tauri/tauri.conf.json (`script-src 'self'`, no `unsafe-inline`),
 *     which would refuse to execute an inline script even if one got this far.
 */

/** Prose and tables. Deliberately no img/svg/math/iframe/object/form/style. */
export const MARKDOWN_ALLOWED_TAGS = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "br",
  "hr",
  "blockquote",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "pre",
  "code",
  "kbd",
  "samp",
  "var",
  "em",
  "strong",
  "s",
  "del",
  "ins",
  "sub",
  "sup",
  "mark",
  "a",
  "span",
  "div",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "colgroup",
  "col",
];

/** No `src`, no `style`, no `target` — and no `on*`, which DOMPurify strips regardless. */
export const MARKDOWN_ALLOWED_ATTR = [
  "href",
  "title",
  "id",
  "class",
  "align",
  "start",
  "colspan",
  "rowspan",
  "dir",
  "lang",
  "rel",
  // Set by the renderer on the image placeholder, and read by nothing else.
  "data-md-src",
];

/**
 * Tighter than DOMPurify's default, which also permits `tel:`, `sms:`, `cid:` and
 * `xmpp:`. Relative hrefs are allowed through — `links.ts` is what decides whether one
 * is safe to act on.
 */
const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

const CONFIG = {
  ALLOWED_TAGS: MARKDOWN_ALLOWED_TAGS,
  ALLOWED_ATTR: MARKDOWN_ALLOWED_ATTR,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ALLOWED_URI_REGEXP,
  // Redundant against the allowlist above, and kept anyway: it states the intent, and it
  // still holds if someone widens ALLOWED_TAGS without thinking it through.
  FORBID_TAGS: [
    "script",
    "style",
    "iframe",
    "object",
    "embed",
    "form",
    "input",
    "button",
    "img",
    "svg",
    "math",
    "link",
    "meta",
    "base",
    "template",
  ],
  FORBID_ATTR: ["src", "srcset", "style", "target", "formaction", "srcdoc", "ping"],
};

/** Minimal HTML escape, for the no-DOM fallback below. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Sanitize rendered markdown, or fail closed.
 *
 * Outside a browser — which is to say under `bun test`, since there is no DOM shim here —
 * DOMPurify's default export is the uninstantiated factory: `isSupported` is false and
 * `sanitize` is not a function at all. Calling it would throw during render.
 *
 * So the no-DOM path escapes instead. The preview then shows the HTML as literal text,
 * which is useless but harmless — the one thing that must never happen is unsanitized
 * markup reaching `dangerouslySetInnerHTML` because the sanitizer quietly wasn't there.
 */
export function sanitizeMarkdown(dirty: string): string {
  if (!isSanitizerAvailable()) return escapeHtml(dirty);
  return DOMPurify.sanitize(dirty, CONFIG);
}

/** Whether a real DOMPurify instance is present. False under `bun test`. */
export function isSanitizerAvailable(): boolean {
  return DOMPurify.isSupported === true && typeof DOMPurify.sanitize === "function";
}
