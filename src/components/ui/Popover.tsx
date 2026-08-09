import { useCallback, useId, useState } from "react";
import type { ReactNode } from "react";
import { useAnchoredPosition, useDismiss, type Align, type Side } from "./useAnchoredPosition";

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
 * Placement and dismissal live in `useAnchoredPosition` / `useDismiss`, shared with
 * `Select` — see that module for why these are positioned with measured fixed
 * coordinates rather than CSS anchoring.
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
  const { triggerRef, panelRef, pos } = useAnchoredPosition<HTMLButtonElement>(open, {
    side,
    align,
  });

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, [triggerRef]);

  useDismiss(open, {
    onDismiss: () => setOpen(false),
    onEscape: close,
    triggerRef,
    panelRef,
  });

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
