import { useEffect, useRef } from "react";

import { Trash2 } from "lucide-react";
import { useIdeStore } from "../../stores/useIdeStore";

export function OutputPanel() {
  const output = useIdeStore((s) => s.output);
  const clearOutput = useIdeStore((s) => s.clearOutput);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [output]);

  return (
    <div className="output-panel">
      <div className="output-toolbar">
        <button
          className="output-clear-btn"
          onClick={clearOutput}
          title="Clear output"
          aria-label="Clear output"
        >
          <Trash2 size={13} />
        </button>
      </div>
      <div className="output-content">
        {output.map((line) =>
          line.mime ? null : (
            <div key={line.id} className={`output-line output-${line.kind}`}>
              <span className="output-text">{line.text}</span>
            </div>
          ),
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
