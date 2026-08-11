import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIdeStore } from "../../stores/useIdeStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { openExternal } from "../../services/openExternal";
import { openFileAtPath } from "../../services/openFile";
import { classifyMarkdownHref } from "../../markdown/links";
import { isMarkdownPath, renderMarkdown } from "../../markdown/renderer";
import { useMarkdownHighlight } from "../../markdown/useMarkdownHighlight";
import { useMarkdownImages } from "../../markdown/useMarkdownImages";
import { useMarkdownMath } from "../../markdown/useMarkdownMath";
import { toast } from "../ui";

/**
 * Rendered markdown for a single tab.
 *
 * Takes the tab id as a **prop** rather than reading `activeTabId`, which is what makes
 * it usable in the split pane: `MonacoEditor` reads the active tab from the store, so two
 * of them side by side both show whatever is focused. A preview driven by an explicit id
 * simply does not have that problem.
 */

/** Re-parse at most this often while typing. */
const RENDER_DEBOUNCE_MS = 120;

export function MarkdownPreview({ tabId }: { tabId: string }) {
  const content = useIdeStore((s) => s.openTabs.find((t) => t.id === tabId)?.content ?? "");
  const docPath = useIdeStore((s) => s.openTabs.find((t) => t.id === tabId)?.path ?? "");
  const workspacePath = useIdeStore((s) => s.workspacePath);

  // Parsing a large README on every keystroke is wasteful; the preview only has to keep
  // up with reading speed.
  const [debounced, setDebounced] = useState(content);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(content), RENDER_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [content]);

  // Fenced code is painted by Monaco, so it follows the editor's theme and indent width.
  const theme = useSettingsStore((s) => s.settings.theme);
  const tabSize = useSettingsStore((s) => s.settings.tabSize);

  const allowLocalImages = useSettingsStore((s) => s.settings.allowLocalImages);
  const allowRemoteImages = useSettingsStore((s) => s.settings.allowRemoteImages);
  const asciiOnly = useSettingsStore((s) => s.settings.asciiOnly);
  const policy = useMemo(
    () => ({ local: allowLocalImages, remote: allowRemoteImages }),
    [allowLocalImages, allowRemoteImages],
  );

  // With both toggles off the renderer emits inert placeholders and the resolver never
  // runs. The store starts unloaded with both defaulting to false, so the pre-load state
  // is fail-closed; the cost is one re-render at startup once settings arrive.
  const html = useMemo(
    () =>
      renderMarkdown(debounced, {
        images: policy.local || policy.remote ? "resolvable" : "blocked",
        asciiOnly,
      }),
    [debounced, policy, asciiOnly],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useMarkdownImages(bodyRef, { html, docPath, workspacePath, policy });
  useMarkdownMath(bodyRef, { html });
  useMarkdownHighlight(bodyRef, { html, theme, tabSize });

  const onClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const anchor = (e.target as HTMLElement).closest("a");
      if (!anchor) return;

      // Unconditional: nothing in the preview may navigate the webview away from the
      // app, whatever the href turns out to be.
      e.preventDefault();

      // `getAttribute` rather than `.href`, which would hand back a resolved absolute
      // URL and lose the relative path we need.
      const link = classifyMarkdownHref(anchor.getAttribute("href"), docPath, workspacePath);

      switch (link.kind) {
        case "external":
          void openExternal(link.url).catch((err) =>
            toast.error("Could not open link", String(err)),
          );
          break;

        case "anchor":
          scrollRef.current
            ?.querySelector(`#${CSS.escape(link.id)}`)
            ?.scrollIntoView({ block: "start" });
          break;

        case "file":
          void openFileAtPath(
            link.path,
            link.path.split("/").pop() ?? link.path,
            // Following a link from a preview into another markdown file should land in
            // a preview too, the way documentation reads elsewhere.
            isMarkdownPath(link.path) ? { viewMode: "preview" } : {},
          ).catch((err) => toast.error("Could not open file", String(err)));
          break;

        case "blocked":
          toast.warning("Link points outside the workspace", link.reason);
          break;

        case "unsupported":
          break;
      }
    },
    [docPath, workspacePath],
  );

  // Middle-click can trigger navigation in a webview all by itself.
  const onAuxClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("a")) e.preventDefault();
  }, []);

  if (!docPath) {
    return (
      <div className="markdown-preview">
        <div className="markdown-preview-body">
          <p>This file is no longer open.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="markdown-preview" ref={scrollRef} onClick={onClick} onAuxClick={onAuxClick}>
      {/*
        The only dangerouslySetInnerHTML in julIDE. `html` comes from renderMarkdown and
        nowhere else: marked with raw-HTML passthrough off, then DOMPurify's allowlist,
        with the CSP (script-src 'self', no unsafe-inline) underneath both. Do not feed
        this element from anywhere but src/markdown/renderer.ts.

        This element's *children* are also mutated by useMarkdownImages, which swaps an
        <img> into each resolvable placeholder. That is deliberate and is what keeps
        `img` and `src` forbidden in the sanitizer allowlist: the document can ask for
        an image, but only julIDE's own code can create one, from bytes it fetched
        itself under a setting the user turned on.
      */}
      <div
        className="markdown-preview-body"
        ref={bodyRef}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
