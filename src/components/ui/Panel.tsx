import type { ReactNode } from "react";
import { iconSize } from "../../themes/tokens";
import type { Tone } from "./Button";

interface PanelProps {
  /** Shown uppercase in condensed type. Omit for panels that own their header. */
  title?: string;
  /** Header controls, right-aligned. Use `IconButton`. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Standard panel scaffold: a labelled header and a scrolling body. */
export function Panel({ title, actions, children, className = "" }: PanelProps) {
  return (
    <div className={`ui-panel ${className}`.trim()}>
      {(title || actions) && (
        <div className="ui-panel-header">
          {title && <span className="ui-panel-title">{title}</span>}
          {actions && <div className="ui-panel-actions">{actions}</div>}
        </div>
      )}
      <div className="ui-panel-body">{children}</div>
    </div>
  );
}

interface EmptyStateProps {
  icon?: ReactNode;
  /** What the panel is for, in one short sentence. */
  title: string;
  /** How to fill it. Name the shortcut if there is one. */
  hint?: ReactNode;
  /** The single action that resolves the emptiness. */
  action?: ReactNode;
}

/**
 * The empty state of a panel is its best chance to teach what the panel does.
 * Several panels previously rendered nothing at all when idle, which is a
 * large part of why julIDE's features are hard to discover.
 */
export function EmptyState({ icon, title, hint, action }: EmptyStateProps) {
  return (
    <div className="ui-empty">
      {icon && <div className="ui-empty-icon">{icon}</div>}
      <div className="ui-empty-text">
        <span className="ui-empty-title">{title}</span>
        {hint && <span className="ui-empty-hint">{hint}</span>}
      </div>
      {action}
    </div>
  );
}

/** Renders a keyboard shortcut inline, e.g. inside an EmptyState hint. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ui-kbd">{children}</kbd>;
}

interface BadgeProps {
  tone?: Tone;
  /** Numeric badges get tabular figures and a minimum width. */
  count?: boolean;
  children: ReactNode;
}

export function Badge({ tone = "neutral", count, children }: BadgeProps) {
  return (
    <span data-tone={tone} className={`ui-tone ui-badge${count ? " ui-badge--count" : ""}`}>
      {children}
    </span>
  );
}

/** A bare state dot for the status bar and tab bars. */
export function Dot({ tone = "neutral", label }: { tone?: Tone; label?: string }) {
  return (
    <span
      data-tone={tone}
      className="ui-tone ui-dot"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

export function Spinner({ size = iconSize.sm, tone = "brand" }: { size?: number; tone?: Tone }) {
  return (
    <span
      data-tone={tone}
      className="ui-tone ui-spinner"
      style={{ width: size, height: size }}
      role="status"
      aria-label="Loading"
    />
  );
}
