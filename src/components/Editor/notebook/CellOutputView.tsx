import { useMemo } from "react";
import { X } from "lucide-react";
import { useNotebookStore } from "../../../stores/useNotebookStore";
import { releaseOutputs } from "../../../services/notebookBlobs";
import { stripAnsiForDisplay } from "../../../utils/juliaOutput";

/**
 * One cell's output, rendered into its view zone through a portal.
 *
 * A portal rather than plain DOM so outputs sit in the normal React tree — theme
 * variables, stores and event handling all work without being re-plumbed.
 */
export function CellOutputView({ cellId }: { cellId: string }) {
  const cell = useNotebookStore((s) => s.cells[cellId]);
  const clearOutputs = useNotebookStore((s) => s.clearOutputs);

  // Memoized on the stored array, not on a `?? []` fallback — that would be a fresh
  // array identity every render and the memo would never hit.
  const hasError = useMemo(
    () => (cell?.outputs ?? []).some((o) => o.kind === "error"),
    [cell?.outputs],
  );

  if (!cell || cell.outputs.length === 0) return null;
  const outputs = cell.outputs;

  const onClear = () => {
    releaseOutputs(outputs);
    clearOutputs(cellId);
  };

  return (
    <div
      className={[
        "notebook-output",
        cell.stale ? "notebook-output--stale" : "",
        hasError ? "notebook-output--error" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="notebook-output-gutter">
        <span className="notebook-output-count">
          {cell.executionCount === null ? " " : `[${cell.executionCount}]`}
        </span>
        <button
          className="notebook-output-clear"
          onClick={onClear}
          title="Clear this cell's output"
          aria-label="Clear this cell's output"
        >
          <X size={11} />
        </button>
      </div>

      <div className="notebook-output-body">
        {cell.stale && (
          <div className="notebook-output-stale-note">The code changed since this ran.</div>
        )}

        {outputs.map((output) => {
          switch (output.kind) {
            case "stream":
              return (
                <pre
                  key={output.id}
                  className={
                    output.name === "stderr"
                      ? "notebook-stream notebook-stream--err"
                      : "notebook-stream"
                  }
                >
                  {stripAnsiForDisplay(output.text ?? "")}
                </pre>
              );

            case "error":
              return (
                <pre key={output.id} className="notebook-traceback">
                  {stripAnsiForDisplay((output.traceback ?? []).join("\n"))}
                </pre>
              );

            default:
              if (output.imageUrl) {
                return (
                  <img key={output.id} className="notebook-image" src={output.imageUrl} alt="" />
                );
              }
              if (output.html) {
                return (
                  <div
                    key={output.id}
                    className="notebook-html"
                    /*
                      Sanitized in notebookBlobs.bundleToOutput, through the same
                      DOMPurify allowlist the markdown preview uses. Julia packages emit
                      HTML tables constantly and that markup is no more trusted than a
                      README's.
                    */
                    dangerouslySetInnerHTML={{ __html: output.html }}
                  />
                );
              }
              return (
                <pre key={output.id} className="notebook-result">
                  {stripAnsiForDisplay(output.text ?? "")}
                </pre>
              );
          }
        })}
      </div>
    </div>
  );
}
