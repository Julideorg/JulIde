import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { useIdeStore } from "../../stores/useIdeStore";
import { EmptyState } from "../ui";
import { iconSize } from "../../themes/tokens";

/**
 * Diagnostics from the language server.
 *
 * Lived inside App.tsx until plugin panels became declarative: registering it from
 * builtinContributions would have been a circular import, so App special-cased it by
 * id. Every other panel now carries its own content, and a lone `id === "problems"`
 * branch in the render path is the kind of exception that quietly accumulates.
 */
export function ProblemsPanel() {
  const problems = useIdeStore((s) => s.problems);
  const lspStatus = useIdeStore((s) => s.lspStatus);

  if (problems.length === 0) {
    return (
      <EmptyState
        icon={<CheckCircle2 size={28} />}
        title={lspStatus === "ready" ? "No problems found" : "Waiting for the language server"}
        hint={
          lspStatus === "ready"
            ? "Errors and warnings from LanguageServer.jl appear here as you type."
            : "Diagnostics appear once the language server has finished starting."
        }
      />
    );
  }

  return (
    <div className="problems-list">
      {problems.map((p) => (
        <div key={p.id} className={`problem-item ${p.severity}`}>
          <span className="problem-severity">
            {p.severity === "error" ? (
              <XCircle size={iconSize.xs} aria-label="Error" />
            ) : (
              <AlertTriangle size={iconSize.xs} aria-label="Warning" />
            )}
          </span>
          <span className="problem-message">{p.message}</span>
          <span className="problem-location tabular">
            {p.file.split(/[/\\]/).pop()}:{p.line}:{p.col}
          </span>
        </div>
      ))}
    </div>
  );
}
