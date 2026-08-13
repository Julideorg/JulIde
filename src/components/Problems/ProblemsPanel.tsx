import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, FolderOpen, PlugZap, XCircle } from "lucide-react";
import { useIdeStore } from "../../stores/useIdeStore";
import { usePluginStore } from "../../stores/usePluginStore";
import { Button, EmptyState } from "../ui";
import { iconSize } from "../../themes/tokens";
import { lspEmptyState, type LspEmptyStateKind } from "./lspEmptyState";

const EMPTY_ICONS: Record<LspEmptyStateKind, ReactNode> = {
  ready: <CheckCircle2 size={28} />,
  error: <PlugZap size={28} />,
  "no-workspace": <FolderOpen size={28} />,
  waiting: <CheckCircle2 size={28} />,
};

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
  const lspErrorMessage = useIdeStore((s) => s.lspErrorMessage);
  const lspBackend = useIdeStore((s) => s.lspBackend);
  const hasWorkspace = useIdeStore((s) => s.workspacePath !== null);

  if (problems.length === 0) {
    const empty = lspEmptyState(lspStatus, lspErrorMessage, lspBackend, hasWorkspace);
    const { action } = empty;
    return (
      <EmptyState
        icon={EMPTY_ICONS[empty.kind]}
        title={empty.title}
        // A string hint is folded by EmptyState; a node is not. The server's own
        // message goes through as a node, because julIDE folds the text it
        // writes and nothing else.
        hint={empty.hintIsOurs ? empty.hint : <>{empty.hint}</>}
        action={
          action && (
            <Button
              variant="filled"
              onClick={() => {
                void usePluginStore.getState().commands.get(action.command)?.execute();
              }}
            >
              {action.label}
            </Button>
          )
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
