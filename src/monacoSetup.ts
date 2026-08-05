import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

/**
 * Bundle Monaco with the app instead of fetching it from a CDN.
 *
 * `@monaco-editor/react` defaults to downloading the editor from jsDelivr at
 * runtime. That breaks julIDE entirely without a network connection — a
 * non-starter for a desktop IDE, and especially for Julia's HPC/air-gapped
 * users — and it means several megabytes of third-party script are executed in
 * a webview that holds the Tauri IPC bridge.
 *
 * Calling `loader.config({ monaco })` with a real (non-type-only) import points
 * it at the locally bundled copy. Every other Monaco import in the codebase is
 * `import type`, which is erased at compile time, so this module is the only
 * place the editor is actually pulled into the bundle.
 *
 * Must be imported before the first `<Editor>` renders.
 */

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

loader.config({ monaco });
