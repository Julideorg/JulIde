import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

type Align = "start" | "center" | "end";
type Side = "top" | "bottom";

interface PopoverProps {
  /** The control that opens the popover. Receives the props it must spread. */
  trigger: (props: {
    ref: React.Ref<HTMLButtonElement>;
    onClick: () => void;
    "aria-expanded": boolean;
    "aria-haspopup": "dialog";
    "aria-controls": string;
  }) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  /** Which side of the trigger to open on. Status bar controls open `top`. */
  side?: Side;
  align?: Align;
  label: string;
}

/**
 * A small anchored surface for controls that were previously read-only text.
 *
 * Positioned with fixed coordinates measured from the trigger rather than CSS
 * anchoring, which is not yet safe across the WebKitGTK / WebView2 / WKWebView
 * spread Tauri runs on.
 */
export function Popover({
  trigger,
  children,
  side = "bottom",
  align = "start",
  label,
}: PopoverProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Measure after paint so the panel's real size is known before placing it.
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = triggerRef.current?.getBoundingClientRect();
    const panel = panelRef.current?.getBoundingClientRect();
    if (!anchor || !panel) return;

    let left =
      align === "start"
        ? anchor.left
        : align === "end"
          ? anchor.right - panel.width
          : anchor.left + anchor.width / 2 - panel.width / 2;

    const top = side === "top" ? anchor.top - panel.height - 6 : anchor.bottom + 6;

    // Keep it on screen.
    const margin = 8;
    left = Math.min(Math.max(margin, left), window.innerWidth - panel.width - margin);

    setPos({ left, top });
  }, [open, side, align]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    // Re-measuring on scroll/resize is more trouble than it is worth for a
    // transient surface; close instead, which is what users expect anyway.
    const onReflow = () => setOpen(false);

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onReflow);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [open, close]);

  return (
    <>
      {trigger({
        ref: triggerRef,
        onClick: () => setOpen((v) => !v),
        "aria-expanded": open,
        "aria-haspopup": "dialog",
        "aria-controls": id,
      })}
      {open && (
        <div
          id={id}
          ref={panelRef}
          role="dialog"
          aria-label={label}
          className="ui-popover"
          style={{
            left: pos?.left ?? 0,
            top: pos?.top ?? 0,
            // Avoid a flash at 0,0 on the frame before measurement lands.
            visibility: pos ? "visible" : "hidden",
          }}
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </>
  );
}

interface MenuItemProps {
  icon?: ReactNode;
  children: ReactNode;
  onSelect: () => void;
  /** Renders in the danger tone and is grouped last. */
  danger?: boolean;
  disabled?: boolean;
  /** Shown right-aligned, e.g. a keyboard shortcut. */
  hint?: string;
}

export function MenuItem({ icon, children, onSelect, danger, disabled, hint }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      data-tone={danger ? "shell" : "neutral"}
      className="ui-tone ui-menu-item"
      onClick={onSelect}
    >
      {icon && <span className="ui-menu-item-icon">{icon}</span>}
      <span className="ui-menu-item-label">{children}</span>
      {hint && <span className="ui-menu-item-hint">{hint}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="ui-menu-separator" role="separator" />;
}

export function Menu({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div role="menu" aria-label={label} className="ui-menu">
      {children}
    </div>
  );
}
