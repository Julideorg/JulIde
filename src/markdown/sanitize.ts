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

/* ─── Standalone SVG documents ──────────────────────────────────────────────────
 *
 * Separate from everything above, and deliberately so: `svg` stays in the markdown
 * FORBID_TAGS list, because a document must still never be able to *express* an SVG.
 * This path is for bytes julIDE fetched itself, on the user's instruction, and is only
 * reached when the image settings are on (see src-tauri/src/images.rs).
 *
 * Rendering an SVG through `<img>` is spec'd as secure static mode — no script, no
 * external references — and that is not sufficient on its own. `URL.createObjectURL`
 * makes a real, navigable URL, and a document opened from `blob:` inherits its
 * creator's origin, which here is the realm holding the IPC bridge. The preview cancels
 * anchor clicks, but an `<img>` is not an anchor and the webview's own "open image in
 * new tab" is outside that handler. So: sanitize, and hand it back as `data:` rather
 * than `blob:` (opaque origin, and no top-level navigation to it).
 */

/** Everything that can execute, load, or navigate — gone before the bytes become a URL. */
export const SVG_FORBID_TAGS = [
  "script",
  "foreignObject",
  "a",
  "use",
  "image",
  "iframe",
  "embed",
  "object",
  "audio",
  "video",
  "handler",
  "listener",
  "set",
  "animate",
  "animateTransform",
  "animateMotion",
];

/**
 * No href in any spelling.
 *
 * Gradients and filters reference by `fill="url(#id)"`, which is an attribute *value*
 * rather than a URI attribute, so nothing legitimate breaks.
 */
export const SVG_FORBID_ATTR = ["href", "xlink:href", "src", "formaction", "ping"];

const SVG_CONFIG = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: SVG_FORBID_TAGS,
  FORBID_ATTR: SVG_FORBID_ATTR,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

const SVG_NAMESPACE = 'xmlns="http://www.w3.org/2000/svg"';

/**
 * Sanitize a standalone SVG document, or fail closed with `null`.
 *
 * Returns null rather than the source when no sanitizer is available — same reason
 * `sanitizeMarkdown` escapes instead of passing through. The one thing that must never
 * happen is unsanitized markup becoming a URL because the sanitizer quietly wasn't there.
 */
export function sanitizeSvgDocument(source: string): string | null {
  if (!isSanitizerAvailable()) return null;
  const clean = DOMPurify.sanitize(source, SVG_CONFIG);
  if (!clean.includes("<svg")) return null;
  // DOMPurify parses as HTML and returns `body.innerHTML`, which can drop the root
  // namespace. Without `xmlns` the data: document is not an SVG at all and renders
  // nothing — a silently blank image rather than an error.
  if (/\sxmlns\s*=/.test(clean)) return clean;
  return clean.replace(/<svg\b/i, `<svg ${SVG_NAMESPACE}`);
}
