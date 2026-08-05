import { installClipboardPolyfill } from "./services/clipboardPolyfill";
// Point @monaco-editor/react at the bundled Monaco instead of the jsDelivr CDN.
// Must come before anything that renders an <Editor>.
import "./monacoSetup";

import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary/ErrorBoundary";
import { registerBuiltinContributions } from "./services/builtinContributions";
import { installGlobalErrorHandlers } from "./services/globalErrorHandler";
import { pluginHost } from "./services/pluginHost";

// Fix clipboard access (e.g. Monaco's context-menu Paste) before anything
// that might read navigator.clipboard loads.
installClipboardPolyfill();

// Catch anything that escapes a component boundary — async failures in particular,
// which no ErrorBoundary can see.
installGlobalErrorHandlers();

// Register all built-in commands, panels, and UI contributions, then load plugins
registerBuiltinContributions().then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
  );

  // Discover and activate plugins after the UI is rendered
  pluginHost.discoverAndLoadAll().catch(console.warn);
});
