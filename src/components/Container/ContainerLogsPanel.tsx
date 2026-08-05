import { useEffect, useRef } from "react";
import { Trash2 } from "lucide-react";
import { useIdeStore } from "../../stores/useIdeStore";

export function ContainerLogsPanel() {
  const logs = useIdeStore((s) => s.containerLogs);
  const clearLogs = useIdeStore((s) => s.clearContainerLogs);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    <div className="container-logs-panel">
      <div className="container-logs-toolbar">
        <button
          className="container-logs-clear-btn"
          onClick={clearLogs}
          title="Clear logs"
          aria-label="Clear logs"
        >
          <Trash2 size={13} />
        </button>
      </div>
      <div className="container-logs-content">
        {logs.length === 0 && <div className="container-logs-empty">No container logs yet.</div>}
        {logs.map((line) => (
          <div key={line.id} className={`container-log-line container-log-${line.kind}`}>
            <span className="container-log-text">{line.text}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
