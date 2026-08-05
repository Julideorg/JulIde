import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Shown in the fallback so the user knows what broke. Use the panel name for
   * scoped boundaries; omit for the app-level one.
   */
  label?: string;
  /**
   * When true, render the compact inline fallback used inside a panel rather
   * than the full-window one.
   */
  inline?: boolean;
}

interface ErrorBoundaryState {
  error: Error | null;
  info: ErrorInfo | null;
}

/**
 * Catches render-time exceptions so one broken panel cannot take down the IDE.
 *
 * Without this, any throw during render unmounts the whole React tree and leaves
 * the user staring at a blank window with no message and no way out but force-quit.
 * That is especially bad for plugin-contributed panels, which are third-party code.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ info });
    console.error(`[julIDE] ${this.props.label ?? "App"} crashed:`, error, info.componentStack);
  }

  private reset = () => {
    this.setState({ error: null, info: null });
  };

  private copyDetails = () => {
    const { error, info } = this.state;
    const details = [
      `julIDE error in: ${this.props.label ?? "App"}`,
      `${error?.name}: ${error?.message}`,
      error?.stack ?? "",
      "--- component stack ---",
      info?.componentStack ?? "",
    ].join("\n");
    void navigator.clipboard?.writeText?.(details);
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const where = this.props.label ?? "julIDE";

    if (this.props.inline) {
      return (
        <div className="error-boundary error-boundary-inline" role="alert">
          <p className="error-boundary-title">{where} failed to render.</p>
          <p className="error-boundary-message">{error.message}</p>
          <div className="error-boundary-actions">
            <button type="button" onClick={this.reset}>
              Retry
            </button>
            <button type="button" onClick={this.copyDetails}>
              Copy details
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="error-boundary error-boundary-full" role="alert">
        <div className="error-boundary-box">
          <h1 className="error-boundary-title">Something went wrong</h1>
          <p className="error-boundary-message">{error.message}</p>
          <p className="error-boundary-hint">
            Your open files are saved on disk. Reloading the window usually recovers the session —
            if it keeps happening, copy the details and open an issue.
          </p>
          <div className="error-boundary-actions">
            <button type="button" onClick={() => window.location.reload()}>
              Reload window
            </button>
            <button type="button" onClick={this.reset}>
              Try to continue
            </button>
            <button type="button" onClick={this.copyDetails}>
              Copy details
            </button>
          </div>
        </div>
      </div>
    );
  }
}
