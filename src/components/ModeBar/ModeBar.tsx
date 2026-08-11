import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { useModalA11y } from "../../hooks/useModalA11y";
import { useIdeStore } from "../../stores/useIdeStore";
import { useAscii } from "../../services/ascii";
import { MODES, parseInput, type ModeResult } from "./modes";

interface ModeBarState {
  open: boolean;
  /** Text the bar opens with, used to route ⌘P and ⌘⇧P into the right mode. */
  initialInput: string;
  openWith: (input: string) => void;
  close: () => void;
}

export const useModeBarStore = create<ModeBarState>((set) => ({
  open: false,
  initialInput: "",
  openWith: (initialInput) => set({ open: true, initialInput }),
  close: () => set({ open: false, initialInput: "" }),
}));

/**
 * The always-visible entry point in the toolbar.
 *
 * julIDE's problem was never a lack of features — it was that 45 commands and
 * 14 panels hid behind an icon rail and a palette you had to know existed.
 * This puts one labelled door in the chrome and teaches its own grammar the
 * moment you open it.
 */
export function ModeBarTrigger() {
  const openWith = useModeBarStore((s) => s.openWith);
  const tabs = useIdeStore((s) => s.openTabs);
  const activeTabId = useIdeStore((s) => s.activeTabId);
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const ascii = useAscii();

  return (
    <button type="button" className="mode-bar-trigger" onClick={() => openWith("")}>
      <span className="mode-bar-trigger-prompt">julia&gt;</span>
      <span className="mode-bar-trigger-label">
        {activeTab ? activeTab.name : "Run, find, or ask"}
      </span>
      {/* Folded here rather than swapped for <Kbd>, which carries no className slot
          and would drop mode-bar-trigger-kbd. */}
      <kbd className="ui-kbd mode-bar-trigger-kbd">{ascii(shortcutLabel())}</kbd>
    </button>
  );
}

function shortcutLabel() {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  return isMac ? "⌘K" : "Ctrl+K";
}

export function ModeBar() {
  const open = useModeBarStore((s) => s.open);
  const initialInput = useModeBarStore((s) => s.initialInput);
  const close = useModeBarStore((s) => s.close);

  const [input, setInput] = useState("");
  const [results, setResults] = useState<ModeResult[]>([]);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const ascii = useAscii();

  const { mode, query } = useMemo(() => parseInput(input), [input]);
  const unavailable = useMemo(() => (open ? (mode.unavailable?.() ?? null) : null), [open, mode]);

  const dismiss = useCallback(() => {
    close();
    setInput("");
    setResults([]);
    setSelected(0);
  }, [close]);

  // Open, and adopt whichever mode the caller asked for.
  useEffect(() => {
    if (!open) return;
    setInput(initialInput);
    setSelected(0);
    // Focus after paint so the caret lands in a laid-out input.
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open, initialInput]);

  // Resolve results. Modes may be async (LSP), so a stale response from a
  // previous keystroke must not overwrite a newer one.
  useEffect(() => {
    if (!open || unavailable) {
      setResults([]);
      return;
    }
    let cancelled = false;
    Promise.resolve(mode.getResults(query))
      .then((r) => {
        if (!cancelled) {
          setResults(r);
          setSelected(0);
        }
      })
      .catch(() => {
        if (!cancelled) setResults([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, mode, query, unavailable]);

  const dialogRef = useModalA11y<HTMLDivElement>(open, { skipInitialFocus: true });

  if (!open) return null;

  const runSelected = async () => {
    const result = results[selected];
    if (!result) return;
    dismiss();
    await result.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runSelected();
    } else if (e.key === "Escape") {
      e.preventDefault();
      dismiss();
    } else if (e.key === "Backspace" && input === "" && mode.prefix) {
      // Backspacing off an empty query leaves the mode, like the Pkg REPL.
      setInput("");
    }
  };

  // The legend is the whole point: opening the bar teaches the grammar.
  const showLegend = mode.prefix === "" && query === "";

  return (
    <div className="mode-bar-overlay" onMouseDown={dismiss}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command bar"
        data-tone={mode.tone}
        className="ui-tone mode-bar"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mode-bar-input-row">
          <span className="mode-bar-prompt">{mode.prompt}</span>
          <input
            ref={inputRef}
            className="mode-bar-input"
            value={input}
            placeholder={ascii(mode.placeholder)}
            spellCheck={false}
            autoComplete="off"
            aria-label={ascii(mode.placeholder)}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>

        {unavailable ? (
          <div className="mode-bar-note">{unavailable}</div>
        ) : showLegend ? (
          <div className="mode-bar-legend">
            {MODES.filter((m) => m.prefix).map((m) => (
              <button
                key={m.id}
                type="button"
                data-tone={m.tone}
                className="ui-tone mode-bar-legend-item"
                onClick={() => {
                  setInput(m.prefix);
                  inputRef.current?.focus();
                }}
              >
                <span className="mode-bar-legend-key">{m.prefix}</span>
                <span className="mode-bar-legend-desc">{ascii(m.description)}</span>
              </button>
            ))}
            <div className="mode-bar-legend-default">{ascii(MODES[0].description)}</div>
          </div>
        ) : results.length === 0 ? (
          <div className="mode-bar-note">No matches</div>
        ) : (
          <ul className="mode-bar-results" role="listbox" aria-label={`${mode.id} results`}>
            {results.map((r, idx) => (
              <li key={r.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={idx === selected}
                  className={`mode-bar-result${idx === selected ? " selected" : ""}`}
                  onMouseEnter={() => setSelected(idx)}
                  onClick={async () => {
                    dismiss();
                    await r.run();
                  }}
                >
                  {/*
                    `hint` is the one field that is always julIDE's own text — command
                    shortcuts, "Enter to install", a symbol kind — so it folds. `label`
                    and `detail` carry filenames, symbol names, container names and LSP
                    diagnostic text, which are data and are left exactly as they came.
                  */}
                  <span className="mode-bar-result-label">{r.label}</span>
                  {r.detail && <span className="mode-bar-result-detail">{r.detail}</span>}
                  {r.hint && <span className="mode-bar-result-hint">{ascii(r.hint)}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Global shortcuts.
 *
 * ⌘P and ⌘⇧P keep working exactly as they did — they now open this bar in the
 * matching mode rather than a separate palette, so nobody has to relearn them.
 */
export function useModeBarShortcuts() {
  const openWith = useModeBarStore((s) => s.openWith);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key.toLowerCase() === "k" && !e.shiftKey) {
        e.preventDefault();
        openWith("");
      } else if (e.key.toLowerCase() === "p" && e.shiftKey) {
        e.preventDefault();
        openWith(">");
      } else if (e.key.toLowerCase() === "p") {
        e.preventDefault();
        openWith("");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [openWith]);
}
