import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Plus, X } from "lucide-react";
import "@xterm/xterm/css/xterm.css";
import { useIdeStore } from "../../stores/useIdeStore";
import { useSettingsStore } from "../../stores/useSettingsStore";
import { themes } from "../../themes/themes";
import { fontStack } from "../../themes/tokens";
import type { PtyOutputEvent } from "../../types";

/** Falls back to the dark theme if a plugin or stale setting names an unknown id. */
function terminalThemeFor(themeId: string): Record<string, string> {
  return (themes[themeId] ?? themes["julide-dark"]).terminalTheme;
}

interface TermInstance {
  terminal: Terminal;
  fitAddon: FitAddon;
  wrapper: HTMLDivElement;
  unlisten: (() => void) | null;
  lastRows: number;
  lastCols: number;
}

let termCounter = 0;

// Instances live at module level so they survive TerminalPanel unmounts:
// PTY output keeps flowing into the (detached) xterm buffers, and the DOM
// wrappers are reparented on remount, preserving scrollback and REPL state.
// The backend keeps its side of the session alive too (pty_create is
// idempotent), so a remount re-attaches instead of restarting the process.
const termInstances = new Map<string, TermInstance>();

// Fit the terminal to its container and propagate the new size to the PTY,
// but only when the geometry actually changed: redundant resizes make
// Windows ConPTY repaint the whole viewport (flicker, mangled scrollback).
function fitAndResize(sessionId: string) {
  const inst = termInstances.get(sessionId);
  if (!inst) return;
  try {
    inst.fitAddon.fit();
  } catch {
    return; // container has no layout yet
  }
  const { rows, cols } = inst.terminal;
  if (rows === inst.lastRows && cols === inst.lastCols) return;
  inst.lastRows = rows;
  inst.lastCols = cols;
  invoke("pty_resize", { sessionId, rows, cols }).catch(() => {});
}

// The backend prunes dead sessions and emits pty-exit; tell the user.
listen<PtyOutputEvent>("pty-exit", (event) => {
  const inst = termInstances.get(event.payload.session_id);
  inst?.terminal.write("\r\n\x1b[31m[process exited]\x1b[0m\r\n");
}).catch(() => {}); // not running inside Tauri (tests, storybook)

function injectRevise(sessionId: string, delayMs = 2500) {
  setTimeout(() => {
    if (useIdeStore.getState().reviseEnabled) {
      invoke("pty_write", { sessionId, data: "using Revise\n" }).catch(console.error);
    }
  }, delayMs);
}

export function TerminalPanel() {
  const workspacePath = useIdeStore((s) => s.workspacePath);
  const sessions = useIdeStore((s) => s.terminalSessions);
  const activeTerminalId = useIdeStore((s) => s.activeTerminalId);
  const addTerminalSession = useIdeStore((s) => s.addTerminalSession);
  const removeTerminalSession = useIdeStore((s) => s.removeTerminalSession);
  const setActiveTerminal = useIdeStore((s) => s.setActiveTerminal);
  const themeId = useSettingsStore((s) => s.settings.theme);
  const terminalFontSize = useSettingsStore((s) => s.settings.terminalFontSize);

  const containerRef = useRef<HTMLDivElement>(null);

  // Create the initial terminal session once. Guarded by store state (not a
  // component ref) so a remount doesn't add a duplicate "Terminal 1".
  useEffect(() => {
    if (useIdeStore.getState().terminalSessions.length > 0) return;
    const id = `terminal-${++termCounter}`;
    addTerminalSession({ id, name: "Terminal 1" });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- mount-only: creates the first terminal once, guarded by a length check

  // Create xterm instances for sessions that don't have one, and re-attach
  // surviving instances after a remount.
  useEffect(() => {
    if (!containerRef.current) return;

    for (const session of sessions) {
      const existing = termInstances.get(session.id);
      if (existing) {
        // Remounted: reparent the wrapper — buffer and PTY stay intact.
        if (existing.wrapper.parentElement !== containerRef.current) {
          containerRef.current.appendChild(existing.wrapper);
          existing.wrapper.style.display = session.id === activeTerminalId ? "block" : "none";
          setTimeout(() => fitAndResize(session.id), 50);
        }
        continue;
      }

      // Read appearance imperatively: making this effect depend on the
      // settings would tear down and recreate every terminal (losing
      // scrollback and the REPL session) whenever the theme changed. The
      // effect below applies those changes in place instead.
      const appearance = useSettingsStore.getState().settings;
      const term = new Terminal({
        cursorBlink: true,
        fontSize: appearance.terminalFontSize,
        fontFamily: fontStack.mono,
        theme: terminalThemeFor(appearance.theme),
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.loadAddon(new WebLinksAddon());

      // Create a wrapper div for this terminal
      const wrapper = document.createElement("div");
      wrapper.className = "terminal-instance";
      wrapper.dataset.sessionId = session.id;
      wrapper.style.display = session.id === activeTerminalId ? "block" : "none";
      wrapper.style.width = "100%";
      wrapper.style.height = "100%";
      containerRef.current.appendChild(wrapper);

      term.open(wrapper);

      const instance: TermInstance = {
        terminal: term,
        fitAddon,
        wrapper,
        unlisten: null,
        lastRows: term.rows,
        lastCols: term.cols,
      };
      // Register before the async setup so a concurrent effect run
      // (StrictMode) hits the re-attach branch instead of creating twice.
      termInstances.set(session.id, instance);

      // Send keystrokes to PTY
      term.onData((data) => {
        invoke("pty_write", { sessionId: session.id, data }).catch(console.error);
      });

      // Start PTY session; returns false when a live session with this id
      // already exists (e.g. after a page reload) and we just re-attach.
      const sessionId = session.id;
      const setup = async () => {
        try {
          const storeState = useIdeStore.getState();
          if (storeState.containerMode && storeState.containerId) {
            await invoke<boolean>("container_pty_create", {
              sessionId,
              containerId: storeState.containerId,
              command: null,
              workingDir: null,
            });
          } else if (session.type === "shell") {
            await invoke<boolean>("pty_create_shell", {
              sessionId,
              workingDir: workspacePath ?? null,
            });
          } else {
            const created = await invoke<boolean>("pty_create", {
              sessionId,
              juliaPath: null,
              projectPath: workspacePath ?? null,
            });
            if (created) injectRevise(sessionId);
          }
        } catch (e) {
          term.writeln(`\x1b[31mFailed to start terminal: ${e}\x1b[0m`);
        }

        instance.unlisten = (await listen<PtyOutputEvent>("pty-output", (event) => {
          if (event.payload.session_id === sessionId) {
            term.write(event.payload.data);
          }
        })) as unknown as () => void;
      };

      setup();
      setTimeout(() => fitAndResize(sessionId), 100);
    }
  }, [sessions, activeTerminalId, workspacePath]);

  // Push appearance changes into terminals that already exist. Instances live
  // at module scope and outlive this component, so they never pick up new
  // settings from the constructor above — they have to be updated in place.
  // A font-size change alters the cell grid, so the PTY needs re-measuring too.
  useEffect(() => {
    const theme = terminalThemeFor(themeId);
    for (const [sessionId, inst] of termInstances) {
      inst.terminal.options.theme = theme;
      inst.terminal.options.fontSize = terminalFontSize;
      fitAndResize(sessionId);
    }
  }, [themeId, terminalFontSize]);

  // Show/hide terminals when active tab changes
  useEffect(() => {
    if (!containerRef.current) return;
    const wrappers = containerRef.current.querySelectorAll<HTMLDivElement>(".terminal-instance");
    wrappers.forEach((w) => {
      w.style.display = w.dataset.sessionId === activeTerminalId ? "block" : "none";
    });
    // Fit the active terminal
    if (activeTerminalId) {
      const inst = termInstances.get(activeTerminalId);
      if (inst) {
        setTimeout(() => {
          fitAndResize(activeTerminalId);
          inst.terminal.focus();
        }, 50);
      }
    }
  }, [activeTerminalId]);

  // ResizeObserver for all terminals
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(() => {
      if (activeTerminalId) {
        fitAndResize(activeTerminalId);
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [activeTerminalId]);

  const addNewTerminal = useCallback(() => {
    const num = ++termCounter;
    const id = `terminal-${num}`;
    addTerminalSession({ id, name: `Terminal ${num}` });
  }, [addTerminalSession]);

  const closeTerminal = useCallback(
    (id: string) => {
      const inst = termInstances.get(id);
      if (inst) {
        inst.unlisten?.();
        inst.terminal.dispose();
        termInstances.delete(id);
        inst.wrapper.remove();
      }
      invoke("pty_close", { sessionId: id }).catch(() => {});
      removeTerminalSession(id);
    },
    [removeTerminalSession],
  );

  // Inject `using Revise` whenever toggle is turned on
  const reviseEnabled = useIdeStore((s) => s.reviseEnabled);
  useEffect(() => {
    if (!reviseEnabled || !activeTerminalId) return;
    injectRevise(activeTerminalId, 500);
  }, [reviseEnabled, activeTerminalId]);

  // Refit the active xterm when the bottom panel switches back to "terminal".
  // While hidden via display:none the inner ResizeObserver doesn't fire, so
  // xterm's renderer can be left at a stale (or zero) size.
  const activeBottomPanel = useIdeStore((s) => s.activeBottomPanel);
  useEffect(() => {
    if (activeBottomPanel !== "terminal" || !activeTerminalId) return;
    const inst = termInstances.get(activeTerminalId);
    if (!inst) return;
    const t = setTimeout(() => {
      fitAndResize(activeTerminalId);
      inst.terminal.focus();
    }, 50);
    return () => clearTimeout(t);
  }, [activeBottomPanel, activeTerminalId]);

  return (
    <div className="terminal-panel">
      <div className="terminal-tabs-bar">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`terminal-tab ${s.id === activeTerminalId ? "active" : ""}`}
            onClick={() => setActiveTerminal(s.id)}
          >
            <span className="terminal-tab-name">{s.name}</span>
            {sessions.length > 1 && (
              <button
                className="terminal-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTerminal(s.id);
                }}
              >
                <X size={10} />
              </button>
            )}
          </div>
        ))}
        <button
          className="terminal-add-btn"
          onClick={addNewTerminal}
          title="New Terminal"
          aria-label="New Terminal"
        >
          <Plus size={13} />
        </button>
      </div>
      <div ref={containerRef} className="terminal-container" />
    </div>
  );
}
