import { useLayoutEffect } from "react";
import katex from "katex";
// Bundled by Vite, never a CDN — julIDE has to typeset offline, the same rule
// monacoSetup.ts follows for the editor itself. Vite rewrites the @font-face URLs and
// emits the faces as app assets, which the CSP already allows (`font-src 'self' data:`).
// Kept out of src/styles/ deliberately: styles.test.ts audits that directory for
// hardcoded colours and import completeness, and a vendored stylesheet is not ours to
// answer for.
import "katex/dist/katex.min.css";

/**
 * Typeset the maths placeholders inside `host`.
 *
 * The counterpart to the extensions in ./math.ts: those emit `<span class="md-math">`
 * carrying TeX as text, and this turns each one into real notation *after* the document
 * has been through DOMPurify. Same shape and same reasoning as `useMarkdownImages` — it
 * is what lets `math` stay in FORBID_TAGS and `style` in FORBID_ATTR, since the document
 * itself never expresses the markup KaTeX produces.
 *
 * A hook rather than code inside MarkdownPreview because notebook markdown cells will
 * want it on the same terms.
 *
 * Two constraints that look like style and are not:
 *
 *  - The query is scoped to `host`, never `document`. Several previews can be mounted at
 *    once in a split, and a document-wide query would have each of them typesetting the
 *    others.
 *  - `md-math--done` makes the effect idempotent. The 120 ms typing debounce re-runs it
 *    against a host whose untouched placeholders must not be typeset twice — and once
 *    KaTeX has replaced the children, `textContent` is no longer the source TeX.
 */

/**
 * KaTeX runs on whatever a cloned repository's README happens to contain, so the options
 * that bound it are not incidental:
 *
 *  - `throwOnError: false` — a malformed expression renders in red, in place. Throwing
 *    inside a layout effect would take the preview down with it.
 *  - `trust: false` (KaTeX's default, stated here because it is the security-relevant
 *    one) — disables `\href`, `\url` and `\includegraphics`, the commands that can
 *    reach outside the expression.
 *  - `maxExpand` and `maxSize` bound macro recursion and `\rule` abuse, so a document
 *    cannot hang or paper over the app with a few lines of TeX.
 */
const KATEX_OPTIONS = {
  throwOnError: false,
  errorColor: "var(--status-danger)",
  strict: false as const,
  trust: false,
  maxSize: 50,
  maxExpand: 1000,
};

export function useMarkdownMath(
  hostRef: React.RefObject<HTMLElement | null>,
  args: { /** The sanitized HTML currently committed to the host. */ html: string },
): void {
  const { html } = args;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    for (const el of host.querySelectorAll<HTMLElement>(".md-math:not(.md-math--done)")) {
      // Read before rendering: katex.render empties the element, so a throw partway
      // through would otherwise lose the source with nothing to put back.
      const tex = el.textContent ?? "";
      el.classList.add("md-math--done");
      if (!tex.trim()) continue;

      try {
        katex.render(tex, el, {
          ...KATEX_OPTIONS,
          displayMode: el.classList.contains("md-math--display"),
        });
      } catch (error) {
        // throwOnError:false covers parse errors; this is for the rest (an unknown
        // environment, a KaTeX assertion). Show the author their own source.
        el.textContent = tex;
        el.classList.add("md-math--error");
        el.title = String(error);
      }
    }
  }, [hostRef, html]);
}
