import type * as Monaco from "monaco-editor";
import type { LspDiagnostic, LspWorkspaceEdit } from "./LspClient";
import { lspClient } from "./LspClient";

// ── Module-level singletons ───────────────────────────────────────────────────

/** Guard so providers are registered only once for the app's lifetime. */
let providersRegistered = false;

/** Cached Monaco instance for use in setMonacoMarkers. */
let _monaco: typeof Monaco | null = null;

/**
 * Registrations that depend on what the server advertised, so they have to be
 * torn down and rebuilt when the backend changes.
 */
let dynamicDisposables: Monaco.IDisposable[] = [];

export function setMonacoInstance(m: typeof Monaco): void {
  _monaco = m;
}

/** Human-readable name of the running backend, for diagnostic attribution. */
function backendLabel(): string {
  switch (lspClient.backend) {
    case "fatou":
      return "Fatou";
    case "jetls":
      return "JETLS.jl";
    default:
      return "LanguageServer.jl";
  }
}

// ── Coordinate conversion helpers ─────────────────────────────────────────────

/** LSP 0-based position → Monaco 1-based IRange start */
export function lspRangeToMonaco(range: {
  start: { line: number; character: number };
  end: { line: number; character: number };
}): Monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

// ── LSP CompletionItemKind → Monaco CompletionItemKind mapping ────────────────

export const LSP_KIND: Record<number, number> = {
  1: 17, // Text
  2: 0, // Method
  3: 1, // Function
  4: 3, // Constructor
  5: 4, // Field
  6: 5, // Variable
  7: 6, // Class
  8: 7, // Interface
  9: 8, // Module
  10: 9, // Property
  11: 10, // Unit
  12: 11, // Value
  13: 12, // Enum
  14: 13, // Keyword
  15: 14, // Snippet
  16: 15, // Color
  17: 16, // File
  18: 17, // Reference
  25: 20, // EnumMember
  26: 21, // Constant
  27: 22, // Struct
};

// ── Severity mapping ──────────────────────────────────────────────────────────

function lspSeverityToMonaco(monaco: typeof Monaco, severity?: number): Monaco.MarkerSeverity {
  switch (severity) {
    case 1:
      return monaco.MarkerSeverity.Error;
    case 2:
      return monaco.MarkerSeverity.Warning;
    case 3:
      return monaco.MarkerSeverity.Info;
    case 4:
      return monaco.MarkerSeverity.Hint;
    default:
      return monaco.MarkerSeverity.Error;
  }
}

// ── Hover content normalization ───────────────────────────────────────────────

export function flattenHoverContents(
  contents:
    string | { kind: string; value: string } | Array<string | { language: string; value: string }>,
): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents
      .map((c) => {
        if (typeof c === "string") return c;
        if ("value" in c) return c.value;
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  return (contents as { value: string }).value ?? "";
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Register all Julia LSP Monaco providers.
 *
 * Called once from monacoSetup, not from an editor mount handler: these are
 * global, language-scoped registrations, so doing it per mount cost work on
 * every tab switch for no benefit.
 *
 * Providers are registered unconditionally but each asks `lspClient.supports`
 * before doing any work, because the backends differ in what they implement
 * (Fatou has no inlay hints, LanguageServer.jl has no range formatting). The
 * registrations that need the server's semantic-token legend cannot be made
 * until the handshake finishes and are deferred to {@link registerDynamicProviders}.
 */
export function registerJuliaLspProviders(monaco: typeof Monaco): void {
  if (providersRegistered) return;
  providersRegistered = true;
  setMonacoInstance(monaco);

  // Rebuild the capability-dependent registrations after every handshake, so
  // switching backends in Settings swaps them rather than leaving stale ones.
  lspClient.onReady(() => registerDynamicProviders(monaco));

  // ── Completions ──────────────────────────────────────────────────────────────
  monaco.languages.registerCompletionItemProvider("julia", {
    triggerCharacters: [".", "(", ",", " "],
    provideCompletionItems: async (model, position) => {
      if (!lspClient.supports("completionProvider")) return { suggestions: [] };
      const uri = `file://${model.uri.path}`;
      try {
        const items = await lspClient.getCompletions(
          uri,
          position.lineNumber - 1,
          position.column - 1,
        );
        const word = model.getWordUntilPosition(position);
        const range: Monaco.IRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        return {
          suggestions: items.map((item) => ({
            label: item.label,
            kind: LSP_KIND[item.kind ?? 1] ?? monaco.languages.CompletionItemKind.Text,
            detail: item.detail,
            documentation:
              typeof item.documentation === "object"
                ? { value: item.documentation.value }
                : item.documentation
                  ? { value: item.documentation }
                  : undefined,
            insertText: item.insertText ?? item.label,
            insertTextRules:
              item.insertTextFormat === 2
                ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                : undefined,
            range,
          })),
        };
      } catch {
        return { suggestions: [] };
      }
    },
  });

  // ── Hover ────────────────────────────────────────────────────────────────────
  monaco.languages.registerHoverProvider("julia", {
    provideHover: async (model, position) => {
      if (!lspClient.supports("hoverProvider")) return null;
      const uri = `file://${model.uri.path}`;
      try {
        const hover = await lspClient.getHover(uri, position.lineNumber - 1, position.column - 1);
        if (!hover) return null;
        return {
          contents: [{ value: flattenHoverContents(hover.contents) }],
          range: hover.range ? lspRangeToMonaco(hover.range) : undefined,
        };
      } catch {
        return null;
      }
    },
  });

  // ── Go to Definition ─────────────────────────────────────────────────────────
  monaco.languages.registerDefinitionProvider("julia", {
    provideDefinition: async (model, position) => {
      if (!lspClient.supports("definitionProvider")) return [];
      const uri = `file://${model.uri.path}`;
      try {
        const locations = await lspClient.getDefinition(
          uri,
          position.lineNumber - 1,
          position.column - 1,
        );
        return locations.map((loc) => ({
          uri: monaco.Uri.parse(loc.uri),
          range: lspRangeToMonaco(loc.range),
        }));
      } catch {
        return [];
      }
    },
  });

  // ── Signature Help ───────────────────────────────────────────────────────────
  monaco.languages.registerSignatureHelpProvider("julia", {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [","],
    provideSignatureHelp: async (model, position) => {
      if (!lspClient.supports("signatureHelpProvider")) return null;
      const uri = `file://${model.uri.path}`;
      try {
        const help = await lspClient.getSignatureHelp(
          uri,
          position.lineNumber - 1,
          position.column - 1,
        );
        if (!help) return null;
        return {
          value: {
            signatures: help.signatures.map((sig) => ({
              label: sig.label,
              documentation:
                sig.documentation == null
                  ? undefined
                  : typeof sig.documentation === "object"
                    ? { value: sig.documentation.value }
                    : { value: sig.documentation },
              parameters: (sig.parameters ?? []).map((p) => ({
                label: p.label,
                documentation:
                  p.documentation == null
                    ? undefined
                    : typeof p.documentation === "object"
                      ? { value: p.documentation.value }
                      : { value: p.documentation },
              })),
            })),
            activeSignature: help.activeSignature ?? 0,
            activeParameter: help.activeParameter ?? 0,
          },
          dispose: () => {},
        };
      } catch {
        return null;
      }
    },
  });

  // ── Find References ───────────────────────────────────────────────────────
  monaco.languages.registerReferenceProvider("julia", {
    provideReferences: async (model, position) => {
      if (!lspClient.supports("referencesProvider")) return [];
      const uri = `file://${model.uri.path}`;
      try {
        const locations = await lspClient.getReferences(
          uri,
          position.lineNumber - 1,
          position.column - 1,
        );
        return locations.map((loc) => ({
          uri: monaco.Uri.parse(loc.uri),
          range: lspRangeToMonaco(loc.range),
        }));
      } catch {
        return [];
      }
    },
  });

  // ── Rename Symbol ─────────────────────────────────────────────────────────
  monaco.languages.registerRenameProvider("julia", {
    provideRenameEdits: async (model, position, newName) => {
      if (!lspClient.supports("renameProvider")) return { edits: [] };
      const uri = `file://${model.uri.path}`;
      try {
        const edit = await lspClient.rename(
          uri,
          position.lineNumber - 1,
          position.column - 1,
          newName,
        );
        if (!edit) return { edits: [] };
        return workspaceEditToMonaco(monaco, edit);
      } catch {
        return { edits: [] };
      }
    },
    resolveRenameLocation: async (model, position) => {
      const uri = `file://${model.uri.path}`;
      try {
        const range = await lspClient.prepareRename(
          uri,
          position.lineNumber - 1,
          position.column - 1,
        );
        if (!range)
          return {
            range: { startLineNumber: 0, startColumn: 0, endLineNumber: 0, endColumn: 0 },
            text: "",
          };
        const monacoRange = lspRangeToMonaco(range);
        const text = model.getValueInRange(monacoRange);
        return { range: monacoRange, text };
      } catch {
        return {
          range: { startLineNumber: 0, startColumn: 0, endLineNumber: 0, endColumn: 0 },
          text: "",
        };
      }
    },
  });

  // ── Code Actions / Quick Fixes ────────────────────────────────────────────
  monaco.languages.registerCodeActionProvider("julia", {
    provideCodeActions: async (model, range, context) => {
      if (!lspClient.supports("codeActionProvider")) return { actions: [], dispose: () => {} };
      const uri = `file://${model.uri.path}`;
      try {
        const lspRange = {
          start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
          end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
        };
        const diagnostics = (context.markers ?? []).map((m) => ({
          range: {
            start: { line: m.startLineNumber - 1, character: m.startColumn - 1 },
            end: { line: m.endLineNumber - 1, character: m.endColumn - 1 },
          },
          severity:
            m.severity === monaco.MarkerSeverity.Error
              ? 1
              : m.severity === monaco.MarkerSeverity.Warning
                ? 2
                : m.severity === monaco.MarkerSeverity.Info
                  ? 3
                  : (4 as 1 | 2 | 3 | 4),
          message: m.message,
          source: m.source ?? undefined,
        }));
        const actions = await lspClient.getCodeActions(uri, lspRange, diagnostics);
        return {
          actions: actions.map((action) => ({
            title: action.title,
            kind: action.kind ?? "quickfix",
            edit: action.edit ? workspaceEditToMonaco(monaco, action.edit) : undefined,
          })),
          dispose: () => {},
        };
      } catch {
        return { actions: [], dispose: () => {} };
      }
    },
  });

  // ── Document Formatting ───────────────────────────────────────────────────
  monaco.languages.registerDocumentFormattingEditProvider("julia", {
    provideDocumentFormattingEdits: async (model, options) => {
      if (!lspClient.supports("documentFormattingProvider")) return [];
      const uri = `file://${model.uri.path}`;
      try {
        const edits = await lspClient.formatting(uri, options.tabSize, options.insertSpaces);
        return edits.map((edit) => ({
          range: lspRangeToMonaco(edit.range),
          text: edit.newText,
        }));
      } catch {
        return [];
      }
    },
  });

  // ── Inlay Hints ───────────────────────────────────────────────────────────
  monaco.languages.registerInlayHintsProvider("julia", {
    provideInlayHints: async (model, range) => {
      // Fatou has no inlay hint support at all; without this gate every
      // viewport change would round-trip a request it always answers empty.
      if (!lspClient.supports("inlayHintProvider")) return { hints: [], dispose: () => {} };
      const uri = `file://${model.uri.path}`;
      try {
        const lspRange = {
          start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
          end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
        };
        const hints = await lspClient.getInlayHints(uri, lspRange);
        return {
          hints: hints.map((h) => ({
            kind:
              h.kind === 1
                ? monaco.languages.InlayHintKind.Type
                : h.kind === 2
                  ? monaco.languages.InlayHintKind.Parameter
                  : monaco.languages.InlayHintKind.Type,
            position: {
              lineNumber: h.position.line + 1,
              column: h.position.character + 1,
            },
            label:
              typeof h.label === "string" ? h.label : h.label.map((part) => part.value).join(""),
            paddingLeft: h.paddingLeft,
            paddingRight: h.paddingRight,
          })),
          dispose: () => {},
        };
      } catch {
        return { hints: [], dispose: () => {} };
      }
    },
  });
}

/**
 * Register the providers that can only be built once the server has answered
 * `initialize`, and replace any from a previous session.
 *
 * Semantic tokens are the reason this exists: the token stream is a list of
 * indices into the server's own legend, so decoding it with a legend we made up
 * would colour the file with whatever token type happened to land at that
 * index. The legend has to come from the handshake.
 */
function registerDynamicProviders(monaco: typeof Monaco): void {
  for (const disposable of dynamicDisposables) disposable.dispose();
  dynamicDisposables = [];

  const legend = lspClient.semanticTokensLegend;
  if (legend) {
    const monacoLegend: Monaco.languages.SemanticTokensLegend = {
      tokenTypes: legend.tokenTypes,
      tokenModifiers: legend.tokenModifiers,
    };
    dynamicDisposables.push(
      monaco.languages.registerDocumentSemanticTokensProvider("julia", {
        getLegend: () => monacoLegend,
        provideDocumentSemanticTokens: async (model) => {
          const uri = `file://${model.uri.path}`;
          try {
            const result = await lspClient.getSemanticTokensFull(uri);
            if (!result) return { data: new Uint32Array(0) };
            return { data: new Uint32Array(result.data) };
          } catch {
            return { data: new Uint32Array(0) };
          }
        },
        releaseDocumentSemanticTokens: () => {},
      }),
    );
  }

  // Format Selection. Fatou advertises this; LanguageServer.jl does not, and
  // registering it there would put a dead "Format Selection" in the menu.
  if (lspClient.supports("documentRangeFormattingProvider")) {
    dynamicDisposables.push(
      monaco.languages.registerDocumentRangeFormattingEditProvider("julia", {
        provideDocumentRangeFormattingEdits: async (model, range, options) => {
          const uri = `file://${model.uri.path}`;
          try {
            const edits = await lspClient.rangeFormatting(
              uri,
              {
                start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
                end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
              },
              options.tabSize,
              options.insertSpaces,
            );
            return edits.map((edit) => ({
              range: lspRangeToMonaco(edit.range),
              text: edit.newText,
            }));
          } catch {
            return [];
          }
        },
      }),
    );
  }
}

// ── Workspace edit conversion helper ──────────────────────────────────────────

function workspaceEditToMonaco(
  monaco: typeof Monaco,
  edit: LspWorkspaceEdit,
): Monaco.languages.WorkspaceEdit {
  const edits: Monaco.languages.IWorkspaceTextEdit[] = [];

  if (edit.changes) {
    for (const [uri, textEdits] of Object.entries(edit.changes)) {
      for (const te of textEdits) {
        edits.push({
          resource: monaco.Uri.parse(uri),
          textEdit: {
            range: lspRangeToMonaco(te.range),
            text: te.newText,
          },
          versionId: undefined,
        });
      }
    }
  }

  if (edit.documentChanges) {
    for (const dc of edit.documentChanges) {
      for (const te of dc.edits) {
        edits.push({
          resource: monaco.Uri.parse(dc.textDocument.uri),
          textEdit: {
            range: lspRangeToMonaco(te.range),
            text: te.newText,
          },
          versionId: undefined,
        });
      }
    }
  }

  return { edits };
}

/**
 * Apply LSP diagnostics as Monaco model markers (inline squiggles).
 * Models persist across tab switches so markers survive remounts.
 */
export function setMonacoMarkers(uri: string, diagnostics: LspDiagnostic[]): void {
  if (!_monaco) return;
  const model = _monaco.editor.getModel(_monaco.Uri.parse(uri));
  if (!model) return;
  _monaco.editor.setModelMarkers(
    model,
    "lsp",
    diagnostics.map((d) => ({
      startLineNumber: d.range.start.line + 1,
      startColumn: d.range.start.character + 1,
      endLineNumber: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
      message: d.message,
      severity: lspSeverityToMonaco(_monaco!, d.severity),
      source: d.source ?? backendLabel(),
    })),
  );
}
