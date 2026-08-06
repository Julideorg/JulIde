import { useEffect, useRef } from "react";

import { Trash2, Terminal } from "lucide-react";
import { useIdeStore } from "../../stores/useIdeStore";
import { EmptyState, Kbd } from "../ui";

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
        {output.length === 0 && (
          <EmptyState
            icon={<Terminal size={28} />}
            title="No output yet"
            hint={
              <>
                Run a file with <Kbd>F5</Kbd> to see its printed output here. Plots and rendered
                HTML go to the Plots panel instead.
              </>
            }
          />
        )}
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
