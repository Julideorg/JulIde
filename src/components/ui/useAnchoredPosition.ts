import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Placement and dismissal for surfaces anchored to a trigger — `Popover` and `Select`.
 *
 * Positioned with fixed coordinates measured from the trigger rather than CSS anchoring,
 * which is not yet safe across the WebKitGTK / WebView2 / WKWebView spread Tauri runs on.
 *
 * One caveat worth knowing: a `position: fixed` panel escapes an ancestor's `overflow`
 * only because nothing above it establishes a containing block. No ancestor of a popover
 * or select sets `transform` / `filter` / `contain` / `will-change` today. Adding one
 * anywhere up the tree would clip these panels, silently.
 */

export type Side = "top" | "bottom";
export type Align = "start" | "center" | "end";

export interface AnchoredPosition {
  left: number;
  top: number;
  /** Present only when `matchTriggerWidth` is set. */
  width?: number;
  /** Space available on the chosen side, so a long list scrolls instead of overflowing. */
  maxHeight?: number;
}

interface Options {
  /** Omit to pick whichever side has more room. */
  side?: Side;
  align?: Align;
  /** Size the panel to its trigger, which is what a dropdown is expected to do. */
  matchTriggerWidth?: boolean;
  /** Upper bound on the panel height, before the viewport is taken into account. */
  maxPanelHeight?: number;
}

/** Gap between trigger and panel, and the minimum margin against the viewport edge. */
const GAP = 6;
const MARGIN = 8;

export function useAnchoredPosition<T extends HTMLElement>(
  open: boolean,
  { side, align = "start", matchTriggerWidth, maxPanelHeight = 280 }: Options = {},
) {
  const triggerRef = useRef<T>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<AnchoredPosition | null>(null);

  // Measure before paint, so the panel's real size is known before it is placed.
  //
  // A stale `pos` is deliberately left behind on close rather than cleared: the panel is
  // unmounted while closed, and on reopen this effect re-measures before the browser
  // paints, so the old coordinates are never visible.
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = triggerRef.current?.getBoundingClientRect();
    const panel = panelRef.current?.getBoundingClientRect();
    if (!anchor || !panel) return;

    const spaceBelow = window.innerHeight - anchor.bottom - GAP - MARGIN;
    const spaceAbove = anchor.top - GAP - MARGIN;

    // An explicit side wins; otherwise open downwards unless there is visibly more room
    // above and the panel does not fit below.
    const resolved: Side =
      side ?? (panel.height <= spaceBelow || spaceBelow >= spaceAbove ? "bottom" : "top");

    const width = matchTriggerWidth ? anchor.width : undefined;
    const panelWidth = width ?? panel.width;

    let left =
      align === "start"
        ? anchor.left
        : align === "end"
          ? anchor.right - panelWidth
          : anchor.left + anchor.width / 2 - panelWidth / 2;

    // Keep it on screen.
    left = Math.min(Math.max(MARGIN, left), window.innerWidth - panelWidth - MARGIN);

    const available = resolved === "top" ? spaceAbove : spaceBelow;
    const maxHeight = Math.max(0, Math.min(maxPanelHeight, available));
    const height = Math.min(panel.height, maxHeight);

    setPos({
      left,
      top: resolved === "top" ? anchor.top - height - GAP : anchor.bottom + GAP,
      width,
      maxHeight,
    });
  }, [open, side, align, matchTriggerWidth, maxPanelHeight]);

  return { triggerRef, panelRef, pos };
}

interface DismissOptions {
  /** Called for an outside pointer press, and for scroll/resize. */
  onDismiss: () => void;
  /** Called for Escape. Separate so callers can restore focus or skip committing. */
  onEscape?: () => void;
  triggerRef: React.RefObject<HTMLElement | null>;
  panelRef: React.RefObject<HTMLElement | null>;
}

/**
 * Close an open anchored surface on outside press, Escape, scroll or resize.
 *
 * Re-measuring on scroll is more trouble than it is worth for a transient surface, so we
 * close instead — which is what users expect anyway. The scroll listener is registered in
 * the capture phase deliberately: scroll does not bubble, and several of these surfaces
 * live inside their own scrolling containers (the Settings body, the git panels), where a
 * bubble-phase listener on `document` would never fire and the panel would strand at
 * stale coordinates.
 */
export function useDismiss(
  open: boolean,
  { onDismiss, onEscape, triggerRef, panelRef }: DismissOptions,
) {
  const dismissRef = useRef(onDismiss);
  const escapeRef = useRef(onEscape);
  dismissRef.current = onDismiss;
  escapeRef.current = onEscape;

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      dismissRef.current();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        (escapeRef.current ?? dismissRef.current)();
      }
    };
    const onReflow = () => dismissRef.current();

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [open, triggerRef, panelRef]);
}

/** Scroll the active option into view without moving the surrounding page. */
export function useScrollActiveIntoView(
  open: boolean,
  active: number,
  panelRef: React.RefObject<HTMLElement | null>,
) {
  useLayoutEffect(() => {
    if (!open || active < 0) return;
    const el = panelRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: "nearest" });
  }, [open, active, panelRef]);
}
