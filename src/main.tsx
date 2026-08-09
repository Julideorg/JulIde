import { installClipboardPolyfill } from "./services/clipboardPolyfill";
// Point @monaco-editor/react at the bundled Monaco instead of the jsDelivr CDN.
// Must come before anything that renders an <Editor>.
import "./monacoSetup";

import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary/ErrorBoundary";
import { registerBuiltinContributions } from "./services/builtinContributions";
import { installGlobalErrorHandlers } from "./services/globalErrorHandler";
import { installMenuCommandListener } from "./services/menuCommands";
import { pluginHost } from "./services/pluginHost";
import { pluginRevocations } from "./services/plugin/revocations";

// Fix clipboard access (e.g. Monaco's context-menu Paste) before anything
// that might read navigator.clipboard loads.
installClipboardPolyfill();

// Catch anything that escapes a component boundary — async failures in particular,
// which no ErrorBoundary can see.
installGlobalErrorHandlers();

// Register all built-in commands, panels, and UI contributions, then load plugins
registerBuiltinContributions().then(() => {
  // StrictMode double-invokes effects in development to surface missing cleanup.
  // It has no effect on production builds. Every effect that allocates something —
  // the PTY session, the file watcher, the LSP client — either has a cleanup or is
  // guarded by a live-state check, so the double-invoke is safe. If a future effect
  // starts misbehaving in dev but not in a build, this is the first thing to suspect.
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );

  // The native menu dispatches into the command registry, so this has to come
  // after registerBuiltinContributions().
  installMenuCommandListener().catch(console.error);

  // Discover and activate plugins after the UI is rendered
  pluginHost.discoverAndLoadAll().catch(console.warn);

  // Refreshes the advisory feed every six hours. Installed after discovery so the
  // first check has already happened by the time the interval starts.
  pluginRevocations.start();
});
