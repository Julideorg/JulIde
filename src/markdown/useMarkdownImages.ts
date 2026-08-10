import { useLayoutEffect } from "react";
import {
  acquireCachedImage,
  acquireImage,
  classifyImageSrc,
  releaseImage,
  type ImageHandle,
  type ImagePolicy,
} from "./images";

/**
 * Replace the resolvable image placeholders inside `host` with real `<img>` elements.
 *
 * A hook rather than code inside MarkdownPreview because notebook markdown cells need
 * exactly this, and a second copy of the refcount discipline is how one of the two
 * copies starts leaking object URLs.
 *
 * Two constraints that look like style and are not:
 *
 *  - The query is scoped to `host`, never `document`. Several previews (or a notebook's
 *    worth of cells) are mounted at once, and a document-wide query would have each of
 *    them resolving every other one's spans and taking references to them.
 *  - Cleanup *releases*; it never revokes. The cache owns revocation, because the same
 *    badge can be on screen in two panes at once.
 */
export function useMarkdownImages(
  hostRef: React.RefObject<HTMLElement | null>,
  args: {
    /** The sanitized HTML currently committed to the host. */
    html: string;
    docPath: string;
    workspacePath: string | null;
    policy: ImagePolicy;
  },
): void {
  const { html, docPath, workspacePath } = args;
  // Depended on as primitives rather than as the object, so a caller that rebuilds the
  // policy literal each render does not re-resolve every image on every keystroke.
  const { local, remote } = args.policy;

  useLayoutEffect(() => {
    const policy = { local, remote };
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    const held: ImageHandle[] = [];

    const attach = (span: HTMLElement, url: string) => {
      const img = document.createElement("img");
      img.src = url;
      // The alt text is the span's own content — see the renderer's image() override.
      img.alt = span.textContent ?? "";
      if (span.title) img.title = span.title;
      img.decoding = "async";
      img.loading = "lazy";
      img.className = "md-img-el";
      img.onerror = () => {
        // Bytes that passed the sniff in Rust can still fail to decode here.
        span.classList.remove("md-img--done");
        span.classList.add("md-img--error");
        span.title = "This image could not be displayed";
        img.remove();
      };
      // Appended inside the span rather than replacing it: the span is the anchor that
      // makes this effect idempotent, via the :not(.md-img--done) filter below.
      span.appendChild(img);
      span.classList.remove("md-img--loading");
      span.classList.add("md-img--done");
    };

    const markBlocked = (span: HTMLElement, reason: string) => {
      span.classList.remove("md-img--loading");
      span.classList.add("md-img--error");
      // On hover, not in a toast: a README with thirty dead badges would otherwise
      // bury the app.
      span.title = reason;
    };

    const spans = host.querySelectorAll<HTMLElement>("span.md-img:not(.md-img--done)");

    for (const span of spans) {
      const target = classifyImageSrc(
        span.getAttribute("data-md-src"),
        docPath,
        workspacePath,
        policy,
      );
      if (target.kind === "blocked") {
        markBlocked(span, target.reason);
        continue;
      }

      // Synchronous, so a re-render from the 120ms typing debounce does not flash every
      // image out and back in.
      const hit = acquireCachedImage(target);
      if (hit) {
        held.push(hit);
        attach(span, hit.url);
        continue;
      }

      span.classList.add("md-img--loading");
      void acquireImage(target).then(
        (handle) => {
          if (cancelled) {
            // The resolve completed anyway — invoke is not abortable — so the handle
            // has to be given back or the entry is pinned forever.
            releaseImage(handle);
            return;
          }
          held.push(handle);
          attach(span, handle.url);
        },
        (error: unknown) => {
          if (!cancelled) markBlocked(span, String(error));
        },
      );
    }

    return () => {
      cancelled = true;
      for (const handle of held) releaseImage(handle);
    };
  }, [hostRef, html, docPath, workspacePath, local, remote]);
}
