import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { X, Table } from "lucide-react";
import type { PtyOutputEvent } from "../../types";
import { PTY_SESSION_ID } from "../../constants";

interface DataFrameViewerProps {
  varName: string;
  onClose: () => void;
}

const DF_START = "%%JULIDE_DF_START%%";
const DF_END = "%%JULIDE_DF_END%%";

export function DataFrameViewer({ varName, onClose }: DataFrameViewerProps) {
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const captureRef = useRef(false);
  const bufferRef = useRef<string[]>([]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    captureRef.current = false;
    bufferRef.current = [];

    const code = `
begin
  println("${DF_START}")
  try
    _df_ = Main.${varName}
    _names_ = string.(names(_df_))
    println(join(_names_, "\\t"))
    for r in 1:min(nrow(_df_), 200)
      vals = [try string(_df_[r, c]) catch; "?" end for c in 1:ncol(_df_)]
      println(join(vals, "\\t"))
    end
  catch e
    println("ERROR:\\t", sprint(showerror, e))
  end
  println("${DF_END}")
end;
`;
    try {
      await invoke("pty_write", { sessionId: PTY_SESSION_ID, data: code + "\n" });
    } catch {
      setError("No Julia REPL running");
      setLoading(false);
    }
  }, [varName]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    listen<PtyOutputEvent>("pty-output", (event) => {
      if (event.payload.session_id !== PTY_SESSION_ID) return;
      const lines = event.payload.data.split("\n");

      for (const line of lines) {
        const trimmed = line.replace(/\r/g, "").trim();

        if (trimmed.includes(DF_START)) {
          captureRef.current = true;
          bufferRef.current = [];
          continue;
        }

        if (trimmed.includes(DF_END)) {
          captureRef.current = false;
          const captured = bufferRef.current;
          if (captured.length > 0 && captured[0].startsWith("ERROR:")) {
            setError(captured[0].replace("ERROR:\t", ""));
          } else if (captured.length > 0) {
            setHeaders(captured[0].split("\t"));
            setRows(captured.slice(1).map((l) => l.split("\t")));
          }
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

  return (
    <div className="dataframe-viewer">
      <div className="dataframe-header">
        <Table size={14} />
        <span>{varName}</span>
        <span className="dataframe-info">
          {rows.length > 0 ? `${rows.length} rows x ${headers.length} cols` : ""}
        </span>
        <button className="dataframe-close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      {loading && <div className="dataframe-loading">Loading...</div>}
      {error && <div className="dataframe-error">{error}</div>}

      {!loading && !error && headers.length > 0 && (
        <div className="dataframe-table-wrapper">
          <table className="dataframe-table">
            <thead>
              <tr>
                <th className="dataframe-row-num">#</th>
                {headers.map((h, i) => (
                  <th key={i}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <tr key={ri}>
                  <td className="dataframe-row-num">{ri + 1}</td>
                  {row.map((cell, ci) => (
                    <td key={ci}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
