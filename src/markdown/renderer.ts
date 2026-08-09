import { Marked } from "marked";
import { escapeHtml, sanitizeMarkdown } from "./sanitize";

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
function createMarked() {
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
        return `<span class="${cls}">${checked ? "☑" : "☐"}</span> `;
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
        // Never emit <img>. The CSP allows `img-src 'self' data: blob:` only — no remote
        // hosts — and there is no command to read local image bytes, so *every* image in
        // a markdown file would fail to load and log a CSP violation per attempt. A
        // placeholder says so plainly instead of showing a broken-image icon.
        const label = escapeHtml(text || title || "image");
        return (
          `<span class="md-img-missing" data-md-src="${escapeHtml(href)}" ` +
          `title="Images are not shown in preview">${label}</span>`
        );
      },
    },
  });

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
export function renderMarkdownUnsafe(source: string): string {
  return createMarked().parse(source) as string;
}

/** Parse and sanitize. The only function the preview component should use. */
export function renderMarkdown(source: string): string {
  return sanitizeMarkdown(renderMarkdownUnsafe(source));
}
