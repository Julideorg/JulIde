import { useLayoutEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { buildLanguageIndex, fenceLanguage, sanitizeColorized } from "./highlight";

/**
 * Syntax-highlight the fenced code blocks inside `host`.
 *
 * Post-sanitize DOM mutation, like `useMarkdownImages` and `useMarkdownMath` — though
 * here it is about *when* Monaco can run rather than about the allowlist: colorizing is
 * asynchronous (a Monarch grammar may still be loading) and the sanitizer is not.
 *
 * The query is scoped to `host`, never `document`: several previews can be mounted at
 * once in a split, and each must colourize only its own.
 */

/**
 * The pre-highlight source, kept per element.
 *
 * Needed because colorized markup joins lines with `<br/>`, so once a block has been
 * painted its `textContent` has lost every newline — re-reading it to re-highlight after
 * a theme change would collapse the code onto one line. A WeakMap rather than a `data-`
 * attribute so it dies with the element when React replaces the document.
 */
const sourceOf = new WeakMap<HTMLElement, string>();

/** Built once. Monaco's language registry is fixed by the time a preview can render. */
let languageIndex: Map<string, string> | null = null;
function languageFor(fence: string): string | undefined {
  languageIndex ??= buildLanguageIndex(monaco.languages.getLanguages());
  return languageIndex.get(fence);
}

export function useMarkdownHighlight(
  hostRef: React.RefObject<HTMLElement | null>,
  args: {
    /** The sanitized HTML currently committed to the host. */
    html: string;
    /** Active julIDE theme. Monaco paints with it, so a switch has to repaint. */
    theme: string;
    tabSize: number;
  },
): void {
  const { html, theme, tabSize } = args;
  const paintedTheme = useRef(theme);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Monaco regenerates its global `.mtkN` colour rules on a theme change, but the class
    // *indices* baked into already-painted markup were assigned under the old theme's
    // colour map and would now point at the wrong entries. So a switch repaints
    // everything rather than leaving it to CSS.
    const repaintAll = paintedTheme.current !== theme;
    paintedTheme.current = theme;

    let cancelled = false;

    for (const el of host.querySelectorAll<HTMLElement>('pre code[class*="language-"]')) {
      if (el.classList.contains("md-hl--done") && !repaintAll) continue;

      const fence = fenceLanguage(el.className);
      if (!fence) continue;
      const languageId = languageFor(fence);
      // An unknown fence tag keeps its plain escaped text — which is what the preview
      // showed for every fence before this hook existed.
      if (!languageId) continue;

      const code = sourceOf.get(el) ?? el.textContent ?? "";
      sourceOf.set(el, code);

      void monaco.editor
        .colorize(code, languageId, { tabSize })
        .then((colorized) => {
          // The await gives React time to swap the document out from under us, and a
          // Monarch grammar can take long enough for that to be more than theoretical.
          if (cancelled) return;
          const safe = sanitizeColorized(colorized);
          if (safe === null) return;
          el.innerHTML = safe;
          // Marked here rather than before the await, which looks equivalent and is
          // not: StrictMode runs every effect twice in development, so a flag set up
          // front is already there when the second run looks at it — and since the
          // first run's cleanup cancelled its own paint, the block ends up skipped by
          // one pass and abandoned by the other. Claiming it only once the colours are
          // actually on the page is what makes the two runs agree.
          el.classList.add("md-hl--done");
        })
        .catch(() => {
          // Leave the plain text. A grammar that fails to load is not worth a toast on
          // top of a document the reader is already looking at.
        });
    }

    return () => {
      cancelled = true;
    };
  }, [hostRef, html, theme, tabSize]);
}
