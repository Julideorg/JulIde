import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { RefreshCw, Eye, Table } from "lucide-react";
import type { PtyOutputEvent } from "../../types";
import { PTY_SESSION_ID } from "../../constants";
import { DataFrameViewer } from "./DataFrameViewer";

interface WorkspaceVar {
  name: string;
  type: string;
  size: string;
  summary: string;
}

// Sentinel markers to capture variable info output from the REPL
const VAR_START = "%%JULIDE_VARS_START%%";
const VAR_END = "%%JULIDE_VARS_END%%";

// Julia code to introspect workspace variables
const INTROSPECT_CODE = `
begin
  println("${VAR_START}")
  for n in names(Main; all=false, imported=false)
    n in (:ans, :include, :eval) && continue
    try
      v = getfield(Main, n)
      t = string(typeof(v))
      s = try string(Base.summarysize(v)) catch; "?" end
      r = try sprint(show, v; context=:limit=>true) catch; "?" end
      r = replace(first(r, 80), '\\n'=>' ')
      println(string(n), "\\t", t, "\\t", s, "\\t", r)
    catch
    end
  end
  println("${VAR_END}")
end;
`;

export function VariableExplorer() {
  const [vars, setVars] = useState<WorkspaceVar[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dfViewer, setDfViewer] = useState<string | null>(null);
  const captureRef = useRef(false);
  const bufferRef = useRef<string[]>([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    captureRef.current = false;
    bufferRef.current = [];

    try {
      await invoke("pty_write", { sessionId: PTY_SESSION_ID, data: INTROSPECT_CODE + "\n" });
    } catch (e) {
      setError("No Julia REPL running. Start a terminal first.");
      setLoading(false);
    }
  }, []);

  // Listen for PTY output and capture variable info
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    listen<PtyOutputEvent>("pty-output", (event) => {
      if (event.payload.session_id !== PTY_SESSION_ID) return;
      const data = event.payload.data;

      // Parse the data line by line (PTY might send partial data)
      const lines = data.split("\n");
      for (const line of lines) {
        const trimmed = line.replace(/\r/g, "").trim();

        if (trimmed.includes(VAR_START)) {
          captureRef.current = true;
          bufferRef.current = [];
          continue;
        }

        if (trimmed.includes(VAR_END)) {
          captureRef.current = false;
          // Parse captured lines
          const parsed: WorkspaceVar[] = [];
          for (const l of bufferRef.current) {
            const parts = l.split("\t");
            if (parts.length >= 4) {
              parsed.push({
                name: parts[0],
                type: parts[1],
                size: parts[2],
                summary: parts.slice(3).join("\t"),
              });
            }
          }
          parsed.sort((a, b) => a.name.localeCompare(b.name));
          setVars(parsed);
          setLoading(false);
          continue;
        }

        if (captureRef.current && trimmed.length > 0) {
          bufferRef.current.push(trimmed);
        }
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, []);

  const isDataFrame = (type: string) =>
    type === "DataFrame" || type.endsWith("DataFrame") || type.includes("DataFrame");

  if (dfViewer) {
    return <DataFrameViewer varName={dfViewer} onClose={() => setDfViewer(null)} />;
  }

  return (
    <div className="variable-explorer">
      <div className="variable-explorer-header">
        <Eye size={14} />
        <span>Workspace</span>
        <button
          className="variable-refresh-btn"
          onClick={refresh}
          disabled={loading}
          title="Refresh variables"
          aria-label="Refresh variables"
        >
          <RefreshCw size={12} className={loading ? "spinning" : ""} />
        </button>
      </div>

      {error && <div className="variable-error">{error}</div>}

      {vars.length === 0 && !loading && !error && (
        <div className="variable-empty">
          <p>No variables in workspace</p>
          <p className="variable-hint">Click refresh after running code in the REPL</p>
        </div>
      )}

      {vars.length > 0 && (
        <div className="variable-table">
          <div className="variable-table-header">
            <span className="var-col-name">Name</span>
            <span className="var-col-type">Type</span>
            <span className="var-col-value">Value</span>
          </div>
          {vars.map((v) => (
            <div
              key={v.name}
              className={`variable-row ${isDataFrame(v.type) ? "variable-row-clickable" : ""}`}
              title={`${v.name}: ${v.type} (${v.size} bytes)\n${v.summary}`}
              onClick={() => isDataFrame(v.type) && setDfViewer(v.name)}
            >
              <span className="var-col-name var-name">
                {isDataFrame(v.type) && <Table size={11} className="var-df-icon" />}
                {v.name}
              </span>
              <span className="var-col-type var-type">{v.type}</span>
              <span className="var-col-value var-value">{v.summary}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
