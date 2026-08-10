import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import { registerJuliaLanguage } from "./components/Editor/juliaLanguage";
import { defineThemes } from "./themes/themes";
import { registerJuliaLspProviders } from "./lsp/juliaProviders";
import { registerCellLens } from "./components/Editor/notebook/cellLens";
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/language/json/json.worker?worker";
import cssWorker from "monaco-editor/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/language/html/html.worker?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker?worker";

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

/**
 * Register the Julia language and the julIDE themes once, globally.
 *
 * These used to live in a `beforeMount` on the git DiffViewer — the only
 * component that had one. The main editor passes `theme="julide-dark"` without
 * registering it, so until a diff happened to open, Monaco fell back to its
 * built-in `vs` theme and julIDE showed a light editor inside a dark app.
 * Doing it here covers every editor, including ones added later.
 */
registerJuliaLanguage(monaco);
defineThemes(monaco);

/**
 * Register the LSP-backed Monaco providers (completion, hover, go-to-definition,
 * rename, code actions, formatting, …) once, globally — for the same reason.
 *
 * These were previously registered from MonacoEditor's `beforeMount`, which was
 * removed in 76110f4 while cutting per-mount work. Nothing else called them, so
 * every LSP feature in the editor — including the inline diagnostic squiggles,
 * which need the Monaco instance this also caches — went quietly dead. Doing it
 * here restores them without putting the work back on the mount path.
 */
registerJuliaLspProviders(monaco);

/**
 * The notebook cell toolbar, for the same once-globally reason as the two above.
 * The provider is a no-op on any `.jl` file that has no `# %%` markers.
 */
registerCellLens(monaco);
