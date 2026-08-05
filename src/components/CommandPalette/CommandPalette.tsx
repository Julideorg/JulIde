import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useModalA11y } from "../../hooks/useModalA11y";
import { useIdeStore } from "../../stores/useIdeStore";
import { usePluginStore } from "../../stores/usePluginStore";

export function CommandPalette() {
  const open = useIdeStore((s) => s.commandPaletteOpen);
  const setOpen = useIdeStore((s) => s.setCommandPaletteOpen);
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const registeredCommands = usePluginStore((s) => s.commands);

  const commands = useMemo(() => Array.from(registeredCommands.values()), [registeredCommands]);

  const filtered = query.trim()
    ? commands.filter(
        (c) =>
          c.label.toLowerCase().includes(query.toLowerCase()) ||
          c.description?.toLowerCase().includes(query.toLowerCase()),
      )
    : commands;

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setSelectedIdx(0);
  }, [setOpen]);

  // Global Cmd+Shift+P handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "P") {
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === "Escape" && open) close();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, close, setOpen]);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  // Traps Tab inside the dialog and restores focus to wherever it was on close.
  const dialogRef = useModalA11y<HTMLDivElement>(open, { skipInitialFocus: true });

  if (!open) return null;

  const runSelected = () => {
    const cmd = filtered[selectedIdx];
    if (cmd) {
      close();
      cmd.execute();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      runSelected();
    } else if (e.key === "Escape") {
      close();
    }
  };

  return (
    <div className="command-palette-overlay" onClick={close}>
      <div
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="command-palette-input"
          placeholder="Type a command..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="command-palette-list">
          {filtered.length === 0 ? (
            <div className="command-palette-empty">No commands found</div>
          ) : (
            filtered.map((cmd, idx) => (
              <div
                key={cmd.id}
                className={`command-palette-item ${idx === selectedIdx ? "selected" : ""}`}
                onClick={() => {
                  close();
                  cmd.execute();
                }}
                onMouseEnter={() => setSelectedIdx(idx)}
              >
                <span className="command-label">{cmd.label}</span>
                {cmd.description && <span className="command-desc">{cmd.description}</span>}
                {cmd.shortcut && <span className="command-shortcut">{cmd.shortcut}</span>}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
