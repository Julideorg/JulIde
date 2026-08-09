import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { FieldShell } from "./Field";
import { iconSize } from "../../themes/tokens";
import { useAnchoredPosition, useDismiss, useScrollActiveIntoView } from "./useAnchoredPosition";
import {
  appendTypeahead,
  firstEnabledIndex,
  isTypeaheadKey,
  lastEnabledIndex,
  nextIndex,
  typeaheadIndex,
} from "./selectNavigation";

/**
 * A themed dropdown, replacing the native `<select>`.
 *
 * julIDE used native selects everywhere, and their *popup list* is drawn by the platform
 * rather than the page — so it stayed white in dark mode no matter what the stylesheet
 * said. `color-scheme` (see scripts/generate-tokens.ts) fixes that on WebView2 and
 * WKWebView, but on Linux/WebKitGTK the popup is a native GTK menu living outside the
 * DOM, which nothing in CSS can reach. Hence a real listbox.
 *
 * This follows the ARIA APG select-only combobox pattern, where **focus never leaves the
 * trigger** and the active option is tracked with `aria-activedescendant`. That is what
 * keeps it safe inside a modal: `useModalA11y`'s focus trap still sees exactly one
 * focusable node per select, so Tab cycling is unaffected.
 */

export interface SelectOption<T extends string | number> {
  value: T;
  label: string;
  /** Right-aligned secondary text, e.g. "recommended". */
  hint?: string;
  disabled?: boolean;
}

interface SelectProps<T extends string | number> {
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  /** Renders the label/hint/error chrome. Omit for a bare control. */
  label?: string;
  hint?: ReactNode;
  error?: string;
  /** Accessible name when there is no visible `label`. */
  ariaLabel?: string;
  ariaLabelledBy?: string;
  /** Forwarded to the trigger — `SettingRow` injects this via cloneElement. */
  id?: string;
  disabled?: boolean;
  /** Appended to the trigger, so each call site keeps its own density. */
  className?: string;
  placeholder?: string;
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  label,
  hint,
  error,
  ariaLabel,
  ariaLabelledBy,
  id,
  disabled,
  className = "",
  placeholder = "Select…",
}: SelectProps<T>) {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  // Typeahead buffer. A ref rather than state: it must not trigger a render, and the
  // timestamp is only ever read inside the keydown handler.
  const typeahead = useRef({ buffer: "", at: 0 });

  const { triggerRef, panelRef, pos } = useAnchoredPosition<HTMLButtonElement>(open, {
    align: "start",
    matchTriggerWidth: true,
  });
  useScrollActiveIntoView(open, active, panelRef);

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const close = useCallback(() => {
    setOpen(false);
    typeahead.current = { buffer: "", at: 0 };
  }, []);

  /** Close and hand focus back, so keyboard users are never stranded. */
  const closeAndFocus = useCallback(() => {
    close();
    triggerRef.current?.focus();
  }, [close, triggerRef]);

  useDismiss(open, { onDismiss: close, onEscape: closeAndFocus, triggerRef, panelRef });

  const openAt = useCallback(
    (index: number) => {
      setActive(index >= 0 ? index : firstEnabledIndex(options));
      setOpen(true);
    },
    [options],
  );

  const commit = useCallback(
    (index: number) => {
      const option = options[index];
      if (!option || option.disabled) return;
      if (option.value !== value) onChange(option.value);
      closeAndFocus();
    },
    [options, value, onChange, closeAndFocus],
  );

  const runTypeahead = useCallback(
    (key: string, from: number) => {
      const now = performance.now();
      const buffer = appendTypeahead(typeahead.current.buffer, key, now - typeahead.current.at);
      typeahead.current = { buffer, at: now };
      const match = typeaheadIndex(options, buffer, from);
      if (match >= 0) setActive(match);
      return match;
    },
    [options],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;

    // Everything handled here is stopped, so an open dropdown never doubles as a
    // shortcut for the dialog or window behind it.
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };

    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        handled();
        openAt(selectedIndex);
        return;
      }
      if (e.key === "Home") {
        handled();
        openAt(firstEnabledIndex(options));
        return;
      }
      if (e.key === "End") {
        handled();
        openAt(lastEnabledIndex(options));
        return;
      }
      if (isTypeaheadKey(e.key)) {
        handled();
        setOpen(true);
        const match = runTypeahead(e.key, selectedIndex >= 0 ? selectedIndex : 0);
        setActive(match >= 0 ? match : firstEnabledIndex(options));
      }
      return;
    }

    const moved = nextIndex(e.key, active, options);
    if (moved !== null) {
      handled();
      setActive(moved);
      return;
    }

    if (e.key === "Enter" || e.key === " ") {
      handled();
      commit(active);
      return;
    }
    // Escape is handled by useDismiss (document capture phase), which reverts without
    // committing. Tab is deliberately not preventDefault'd: it commits and moves on.
    if (e.key === "Tab") {
      commit(active);
      return;
    }
    if (isTypeaheadKey(e.key)) {
      handled();
      runTypeahead(e.key, active >= 0 ? active : 0);
    }
  };

  const control = (controlId: string) => (
    <>
      <button
        type="button"
        id={controlId}
        ref={triggerRef}
        role="combobox"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listboxId}-${active}` : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-invalid={error ? true : undefined}
        className={`ui-select-trigger ${className}`.trim()}
        onClick={() => (open ? closeAndFocus() : openAt(selectedIndex))}
        onKeyDown={onKeyDown}
      >
        <span className="ui-select-value">{selected?.label ?? placeholder}</span>
        <ChevronDown size={iconSize.sm} className="ui-select-chevron" aria-hidden="true" />
      </button>

      {open && (
        <div
          id={listboxId}
          ref={panelRef}
          role="listbox"
          aria-label={ariaLabel ?? label}
          className="ui-popover ui-select-popover"
          style={{
            left: pos?.left ?? 0,
            top: pos?.top ?? 0,
            width: pos?.width,
            maxHeight: pos?.maxHeight,
            // Avoid a flash at 0,0 on the frame before measurement lands.
            visibility: pos ? "visible" : "hidden",
          }}
        >
          {options.map((o, i) => (
            <div
              key={String(o.value)}
              id={`${listboxId}-${i}`}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              data-active={i === active}
              className="ui-select-option"
              // Options are plain divs, not buttons: a button would be tab-focusable,
              // would show up in useModalA11y's focusable query, and would break both
              // the dialog focus trap and the active-descendant model.
              onMouseEnter={() => !o.disabled && setActive(i)}
              onMouseDown={(e) => e.preventDefault()} // keep focus on the trigger
              onClick={() => commit(i)}
            >
              <span className="ui-select-option-check" aria-hidden="true">
                {o.value === value && <Check size={iconSize.xs} />}
              </span>
              <span className="ui-select-option-label">{o.label}</span>
              {o.hint && <span className="ui-select-option-hint">{o.hint}</span>}
            </div>
          ))}
        </div>
      )}
    </>
  );

  // Without a visible label there is no chrome to render, and wrapping in FieldShell
  // would add a stray flex container that the call site's own layout does not expect.
  if (!label && !hint && !error) return control(id ?? listboxId + "-trigger");

  return (
    <FieldShell label={label} hint={hint} error={error} id={id}>
      {control}
    </FieldShell>
  );
}
