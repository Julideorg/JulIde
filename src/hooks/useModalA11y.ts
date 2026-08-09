import { useEffect, useRef } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

interface Options {
  /** Called when Escape is pressed. Omit if the caller already handles it. */
  onEscape?: () => void;
  /**
   * Skip moving focus into the dialog on open. Use for overlays that manage their
   * own initial focus, such as a search box that must stay selected.
   */
  skipInitialFocus?: boolean;
}

/**
 * Focus management for a modal overlay.
 *
 * Without this, keyboard focus stays wherever it was — behind the overlay — so Tab
 * walks through the editor and sidebar underneath a "modal" dialog, and closing it
 * leaves focus nowhere useful. Screen readers likewise have no signal that the rest
 * of the page is inert.
 *
 * Attach the returned ref to the dialog element and give that element
 * `role="dialog"` and `aria-modal="true"`.
 */
export function useModalA11y<T extends HTMLElement>(open: boolean, options: Options = {}) {
  const ref = useRef<T>(null);
  const { onEscape, skipInitialFocus } = options;

  // Kept in a ref so the effect below does not re-run when the caller passes a new
  // inline closure on every render.
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!open) return;
    const node = ref.current;
    if (!node) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    if (!skipInitialFocus) {
      const first = node.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? node).focus();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onEscapeRef.current) {
        // An open dropdown inside the dialog gets first refusal on Escape. This
        // listener is on `document` in the capture phase, so it runs before anything
        // in the dialog and `stopPropagation` from the control cannot beat it —
        // without this check, Escape in a Select would close the dialog as well.
        if (document.activeElement?.getAttribute("aria-expanded") === "true") return;
        e.preventDefault();
        onEscapeRef.current();
        return;
      }
      if (e.key !== "Tab") return;

      const focusable = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      // Wrap at both ends so Tab cannot escape the dialog.
      if (e.shiftKey && (active === first || !node.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      // Return focus where it was, so closing a dialog does not strand the keyboard.
      previouslyFocused?.focus?.();
    };
  }, [open, skipInitialFocus]);

  return ref;
}
