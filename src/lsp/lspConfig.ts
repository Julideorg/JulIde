import type { Settings } from "../stores/useSettingsStore";
import type { LspStartOptions } from "./LspClient";

/**
 * Fatou's settings payload, shared by `initializationOptions` and
 * `workspace/didChangeConfiguration`.
 *
 * The keys are kebab-case because Fatou parses this with the same schema it
 * uses for `fatou.toml` — `lineWidth` would simply be ignored. A `fatou.toml`
 * found in the project shadows everything sent here, which is Fatou's
 * documented precedence, so these values are a default rather than an override.
 */
export function fatouConfigPayload(settings: Settings): unknown {
  return {
    format: {
      "line-width": settings.fatouLineWidth,
      "indent-width": settings.fatouIndentWidth,
    },
  };
}

/**
 * Build the start options for the currently configured backend.
 *
 * Only Fatou understands the configuration payload; LanguageServer.jl and
 * JETLS.jl get null, which is what they were always sent.
 */
export function lspStartOptions(settings: Settings): LspStartOptions {
  return {
    backend: settings.lspBackend,
    initializationOptions: settings.lspBackend === "fatou" ? fatouConfigPayload(settings) : null,
  };
}
