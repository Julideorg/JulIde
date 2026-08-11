import { Marked } from "marked";
import { mathExtensions } from "./math";
import { escapeHtml, sanitizeMarkdown } from "./sanitize";
import { foldAscii } from "../services/ascii";

/**
 * Markdown → HTML for the preview pane.
 *
 * `marked` rather than a new dependency: monaco-editor already uses it for LSP hover and
 * suggestion docs, so it is a parser this project already ships and already trusts.
 *
 * Raw HTML passthrough is **off**. Authored `<details>`, `<img>` and `<br>` in a README
 * therefore appear as literal text, which does look wrong on HTML-heavy documents — the
 * trade is that no path exists from a cloned repository's README to live markup, so the
 * sanitizer in ./sanitize.ts is defense in depth rather than the only wall. Turning it
 * back on is a one-line change once the allowlist has had some mileage.
 */

/** Extensions julIDE treats as markdown. */
const MARKDOWN_EXTENSIONS = /\.(md|markdown|mdown|mkd|mkdn)$/i;

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.test(path);
}

/** Schemes a link is allowed to carry. Everything else renders as inert text. */
const SAFE_HREF = /^(?:https?:|mailto:|#|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

/** `## Getting Started` → `getting-started`, so `#getting-started` resolves. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * Headings are slugged with a per-document counter, so two "Usage" headings do not both
 * answer to `#usage`. Reset for every render — hence an instance rather than the shared
 * `marked` singleton, which would leak slug state between documents.
 */
/**
 * `"blocked"` — every image is an inert placeholder. The default, so every existing
 * call site keeps today's behaviour.
 *
 * `"resolvable"` — images become spans the preview *may* resolve after sanitization.
 * Emitting one promises nothing: the setting is re-checked and the path re-confined in
 * Rust before a byte is read.
 */
export type ImageMode = "blocked" | "resolvable";

export interface RenderOptions {
  images?: ImageMode;
  /**
   * Fold julIDE's own glyphs in the output to ASCII.
   *
   * Only julIDE's: the task-list boxes it substitutes for the `<input>` the sanitizer
   * strips, and the wording it puts in a blocked image's tooltip. The document's own
   * text is never touched — its em dashes and its maths are its own.
   */
  asciiOnly?: boolean;
}

function createMarked(options: RenderOptions = {}) {
  const images = options.images ?? "blocked";
  const ascii = (s: string) => foldAscii(s, options.asciiOnly ?? false);
  const seen = new Map<string, number>();
  const md = new Marked({
    gfm: true,
    breaks: false,
    // No raw HTML. See the note at the top of this file.
    async: false,
  });

  md.use({
    renderer: {
      // Raw HTML becomes literal text. marked has no `html: false` switch — overriding
      // these two renderers *is* how passthrough is turned off, for block-level HTML
      // (`<details>…`) and inline tags (`<br>`, `<sub>`) respectively.
      html({ text }) {
        return escapeHtml(text);
      },

      // GFM task lists default to `<input type="checkbox">`, and `input` is not in the
      // sanitizer's allowlist — so the boxes would be stripped and the list would render
      // as bare text. A span carries the same meaning through the allowlist intact.
      checkbox({ checked }) {
        // State is carried by the glyph itself rather than a data attribute or aria-*,
        // both of which the sanitizer strips — and a real ☑/☐ character reads correctly
        // to a screen reader anyway.
        const cls = checked ? "md-task md-task--done" : "md-task";
        return `<span class="${cls}">${ascii(checked ? "☑" : "☐")}</span> `;
      },

      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        const slug = slugify(stripTags(text));
        const count = seen.get(slug) ?? 0;
        seen.set(slug, count + 1);
        const id = count === 0 ? slug : `${slug}-${count}`;
        return `<h${depth} id="${escapeHtml(id)}">${text}</h${depth}>\n`;
      },

      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        if (!SAFE_HREF.test(href.trim())) {
          // A `javascript:` or `data:` href never becomes an anchor at all.
          return text;
        }
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
        // rel is belt-and-braces: the click handler calls preventDefault on everything,
        // so no anchor here ever navigates on its own.
        return `<a href="${escapeHtml(href)}"${titleAttr} rel="noreferrer noopener">${text}</a>`;
      },

      image({ href, title, text }) {
        // Never an <img>, in either mode. The element is created programmatically by
        // useMarkdownImages *after* sanitization, which is what lets `img` stay in
        // FORBID_TAGS and `src` in FORBID_ATTR: a document can ask for an image, but
        // it can never put one on the page itself.
        const src = escapeHtml(href);
        if (images === "blocked") {
          const label = escapeHtml(text || title || "image");
          return (
            `<span class="md-img-missing" data-md-src="${src}" ` +
            `title="${ascii("Images are turned off in Settings → Appearance")}">${label}</span>`
          );
        }
        // The alt is the span's *text content* rather than a data attribute:
        // ALLOW_DATA_ATTR is false, so a second data-* would need adding to the
        // sanitizer allowlist. It also degrades correctly — if resolution fails, the
        // visible text is already the alt text.
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
        return `<span class="md-img" data-md-src="${src}"${titleAttr}>${escapeHtml(text)}</span>`;
      },
    },
  });

  // TeX delimiters. These only emit inert placeholders — useMarkdownMath typesets them
  // after sanitization, for the reasons set out in ./math.ts.
  md.use({ extensions: mathExtensions });

  return md;
}

/**
 * Reduce already-rendered inline heading markup to bare text for slugging.
 *
 * Entities have to go as well as tags: the heading text arrives escaped, so `What's`
 * is `What&#39;s` by this point, and slugifying that directly yields `what39s-new`.
 */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/gi, "");
}

/**
 * Parse markdown to HTML **without sanitizing**.
 *
 * Exported for tests: this is the layer whose escaping can be verified without a DOM.
 * Application code should call `renderMarkdown` instead.
 */
export function renderMarkdownUnsafe(source: string, options?: RenderOptions): string {
  return createMarked(options).parse(source) as string;
}

/** Parse and sanitize. The only function the preview component should use. */
export function renderMarkdown(source: string, options?: RenderOptions): string {
  return sanitizeMarkdown(renderMarkdownUnsafe(source, options));
}
