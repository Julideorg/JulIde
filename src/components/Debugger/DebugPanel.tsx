import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Bug } from "lucide-react";
import { useIdeStore } from "../../stores/useIdeStore";
import { EmptyState, Kbd } from "../ui";
import type { DebugOutputEvent, DebugStoppedEvent, DebugVariablesEvent } from "../../types";

export function DebugPanel() {
  const debug = useIdeStore((s) => s.debug);
  const setDebugState = useIdeStore((s) => s.setDebugState);
  const appendOutput = useIdeStore((s) => s.appendOutput);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];

    const setup = async () => {
      const u1 = await listen<DebugOutputEvent>("debug-output", (e) => {
        appendOutput({
          kind: e.payload.kind as "stdout" | "stderr" | "info",
          text: e.payload.text,
        });
      });

      const u2 = await listen<DebugStoppedEvent>("debug-stopped", (e) => {
        setDebugState({
          isPaused: true,
          currentFile: e.payload.file,
          currentLine: e.payload.line,
        });
        // Fetch variables
        invoke("debug_get_variables").catch(console.error);
      });

      const u3 = await listen<DebugVariablesEvent>("debug-variables", (e) => {
        setDebugState({ variables: e.payload.variables });
      });

      unlisteners.push(u1, u2, u3);
    };

    setup();
    return () => unlisteners.forEach((u) => u());
  }, [setDebugState, appendOutput]);

  if (!debug.isDebugging) {
    return (
      <EmptyState
        icon={<Bug size={28} />}
        title="No debug session running"
        hint={
          <>
            Click the gutter beside a line number to set a breakpoint, then start debugging with{" "}
            <Kbd>F5</Kbd>. Variables, the call stack and step controls appear here. Needs
            Debugger.jl.
          </>
        }
      />
    );
  }

  return (
    <div className="debug-panel">
      <div className="debug-status">
        {debug.isPaused ? (
          <span className="debug-paused">
            ⏸ Paused at {debug.currentFile}:{debug.currentLine}
          </span>
        ) : (
          <span className="debug-running">▶ Running...</span>
        )}
      </div>

      <div className="debug-section">
        <div className="debug-section-title">Variables</div>
        {debug.variables.length === 0 ? (
          <div className="debug-empty">No variables</div>
        ) : (
          <table className="debug-variables-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {debug.variables.map((v) => (
                <tr key={v.name}>
                  <td className="var-name">{v.name}</td>
                  <td className="var-type">{v.type_name}</td>
                  <td className="var-value">{v.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="debug-section">
        <div className="debug-section-title">Breakpoints</div>
        <BreakpointsList />
      </div>
    </div>
  );
}

function BreakpointsList() {
  const breakpoints = useIdeStore((s) => s.breakpoints);
  const removeBreakpoint = useIdeStore((s) => s.removeBreakpoint);

  if (breakpoints.length === 0) {
    return <div className="debug-empty">No breakpoints. Click the gutter to add one.</div>;
  }

  return (
    <ul className="breakpoints-list">
      {breakpoints.map((bp) => (
        <li key={`${bp.file}:${bp.line}`} className="breakpoint-item">
          <span className="bp-dot">●</span>
          <span className="bp-location">
            {bp.file.split(/[/\\]/).pop()}:{bp.line}
          </span>
          <button
            className="bp-remove"
            onClick={() => {
              removeBreakpoint(bp.file, bp.line);
              invoke("debug_remove_breakpoint", { file: bp.file, line: bp.line }).catch(
                console.error,
              );
            }}
            title="Remove breakpoint"
            aria-label="Remove breakpoint"
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
