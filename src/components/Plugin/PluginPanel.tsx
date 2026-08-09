import { ErrorBoundary } from "../ErrorBoundary/ErrorBoundary";
import { PluginViewFrame } from "./PluginViewFrame";
import type { PanelContent } from "../../types/plugin";

interface PluginPanelProps {
  content: PanelContent;
  /** Panel name, used in the error fallback when this panel throws. */
  label?: string;
}

/**
 * Renders whatever a panel contributes.
 *
 * There used to be a third path here — a `render(container)` callback handed a live
 * `HTMLElement` from the real page — which is how a plugin reached the host DOM. It is
 * gone, and `PanelContent` has no variant for it, so this component cannot express it
 * even by accident.
 */
export function PluginPanel({ content, label }: PluginPanelProps) {
  return (
    <ErrorBoundary label={label ?? "This panel"} inline>
      {content.kind === "component" ? (
        <content.component />
      ) : (
        <PluginViewFrame view={content.view} label={label} />
      )}
    </ErrorBoundary>
  );
}
