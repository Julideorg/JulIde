import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { basename, pathToUri } from "./uri";

// ── LSP types (minimal subset we actually use) ────────────────────────────────

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: 1 | 2 | 3 | 4; // Error=1, Warning=2, Info=3, Hint=4
  message: string;
  source?: string;
}

export interface LspPublishDiagnosticsParams {
  uri: string;
  diagnostics: LspDiagnostic[];
}

export interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { kind: string; value: string };
  insertText?: string;
  insertTextFormat?: 1 | 2; // 1=PlainText, 2=Snippet
}

export interface LspCompletionList {
  isIncomplete: boolean;
  items: LspCompletionItem[];
}

export interface LspHover {
  contents:
    string | { kind: string; value: string } | Array<string | { language: string; value: string }>;
  range?: LspRange;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspSignatureHelp {
  signatures: Array<{
    label: string;
    documentation?: string | { kind: string; value: string };
    parameters?: Array<{
      label: string | [number, number];
      documentation?: string | { kind: string; value: string };
    }>;
  }>;
  activeSignature?: number;
  activeParameter?: number;
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: Array<{
    textDocument: { uri: string; version?: number | null };
    edits: LspTextEdit[];
  }>;
}

export interface LspCodeAction {
  title: string;
  kind?: string;
  diagnostics?: LspDiagnostic[];
  edit?: LspWorkspaceEdit;
  command?: { title: string; command: string; arguments?: unknown[] };
}

export interface LspInlayHint {
  position: LspPosition;
  label: string | Array<{ value: string; tooltip?: string }>;
  kind?: 1 | 2; // 1=Type, 2=Parameter
  paddingLeft?: boolean;
  paddingRight?: boolean;
}

export interface LspSemanticTokens {
  resultId?: string;
  data: number[];
}

export interface LspCallHierarchyItem {
  name: string;
  kind: number;
  uri: string;
  range: LspRange;
  selectionRange: LspRange;
  detail?: string;
}

export interface LspCallHierarchyIncomingCall {
  from: LspCallHierarchyItem;
  fromRanges: LspRange[];
}

export interface LspCallHierarchyOutgoingCall {
  to: LspCallHierarchyItem;
  fromRanges: LspRange[];
}

export interface LspSemanticTokensLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
}

/**
 * The subset of `ServerCapabilities` we branch on.
 *
 * Backends differ in what they implement — Fatou has no inlay hints but does
 * support range formatting, LanguageServer.jl is the other way round — so
 * providers must ask rather than assume. Anything absent is simply undefined.
 */
export interface LspServerCapabilities {
  completionProvider?: unknown;
  hoverProvider?: unknown;
  definitionProvider?: unknown;
  referencesProvider?: unknown;
  documentHighlightProvider?: unknown;
  renameProvider?: unknown;
  codeActionProvider?: unknown;
  documentFormattingProvider?: unknown;
  documentRangeFormattingProvider?: unknown;
  documentSymbolProvider?: unknown;
  workspaceSymbolProvider?: unknown;
  signatureHelpProvider?: unknown;
  inlayHintProvider?: unknown;
  callHierarchyProvider?: unknown;
  typeHierarchyProvider?: unknown;
  foldingRangeProvider?: unknown;
  selectionRangeProvider?: unknown;
  documentLinkProvider?: unknown;
  semanticTokensProvider?: { legend?: LspSemanticTokensLegend };
}

/** Options for {@link LspClient.start} — which backend, and its configuration. */
export interface LspStartOptions {
  /** Backend id from settings: "fatou" | "languageserver" | "jetls". */
  backend: string;
  /**
   * `initializationOptions` payload. Fatou parses the same schema here that it
   * parses from `fatou.toml`; the Julia-hosted backends want null.
   */
  initializationOptions?: unknown;
}

// ── Notification handler type ─────────────────────────────────────────────────

export type LspNotificationHandler = (method: string, params: unknown) => void;

/** Called once the handshake completes, with whatever the server advertised. */
export type LspReadyHandler = (capabilities: LspServerCapabilities) => void;

// ── Client capabilities ───────────────────────────────────────────────────────

/**
 * What JulIDE tells the server it can handle.
 *
 * Deliberately omits `general.positionEncodings`: Fatou negotiates UTF-8 byte
 * offsets when a client offers them, and Monaco counts in UTF-16 code units.
 * Staying silent keeps the LSP-mandated UTF-16 default, which is what Monaco
 * wants — advertising UTF-8 here would silently misplace every range in a file
 * containing non-ASCII text.
 *
 * Also omits `textDocument.diagnostic`, which would switch Fatou into pull
 * mode; the push `publishDiagnostics` path is what App.tsx consumes.
 */
const CLIENT_CAPABILITIES = {
  textDocument: {
    completion: {
      completionItem: {
        snippetSupport: true,
        documentationFormat: ["markdown", "plaintext"],
      },
    },
    hover: { contentFormat: ["markdown", "plaintext"] },
    definition: {},
    references: {},
    rename: { prepareSupport: true },
    codeAction: {
      codeActionLiteralSupport: {
        codeActionKind: {
          valueSet: [
            "quickfix",
            "refactor",
            "refactor.extract",
            "refactor.inline",
            "refactor.rewrite",
            "source",
            "source.organizeImports",
          ],
        },
      },
    },
    formatting: {},
    rangeFormatting: {},
    signatureHelp: {
      signatureInformation: {
        documentationFormat: ["markdown", "plaintext"],
        parameterInformation: { labelOffsetSupport: true },
      },
    },
    publishDiagnostics: { relatedInformation: false },
    documentSymbol: {
      hierarchicalDocumentSymbolSupport: true,
    },
    inlayHint: {},
    semanticTokens: {
      dynamicRegistration: false,
      requests: { full: { delta: false }, range: false },
      tokenTypes: [
        "namespace",
        "type",
        "class",
        "enum",
        "interface",
        "struct",
        "typeParameter",
        "parameter",
        "variable",
        "property",
        "enumMember",
        "event",
        "function",
        "method",
        "macro",
        "keyword",
        "modifier",
        "comment",
        "string",
        "number",
        "regexp",
        "operator",
        "decorator",
      ],
      tokenModifiers: [
        "declaration",
        "definition",
        "readonly",
        "static",
        "deprecated",
        "abstract",
        "async",
        "modification",
        "documentation",
        "defaultLibrary",
      ],
      formats: ["relative"],
      multilineTokenSupport: false,
    },
    callHierarchy: { dynamicRegistration: false },
  },
} as const;

// ── LspClient class ───────────────────────────────────────────────────────────

class LspClient {
  private notificationUnlisten: (() => void) | null = null;
  private notificationHandlers: LspNotificationHandler[] = [];
  private readyHandlers: LspReadyHandler[] = [];
  private rootUri = "";

  /** What the server advertised in its initialize response; null until ready. */
  private _capabilities: LspServerCapabilities | null = null;

  /** Backend id the current session was started with. */
  private _backend = "";

  /**
   * Whether initialization is complete and the server is ready to receive
   * document sync notifications and language feature requests.
   * Before this is true, didOpen/didChange/getCompletions etc. are no-ops.
   */
  private _isReady = false;

  /**
   * URIs that LS.jl has been told are open (via textDocument/didOpen).
   * Used to prevent duplicate didOpen and to gate didChange/didClose.
   */
  private _openDocuments = new Set<string>();

  /**
   * Documents opened before LSP was ready. Flushed once _isReady = true.
   */
  private _pendingOpens = new Map<string, string>(); // uri → text

  get isReady(): boolean {
    return this._isReady;
  }

  /** Backend id ("fatou" | "languageserver" | "jetls") of the running session. */
  get backend(): string {
    return this._backend;
  }

  get capabilities(): LspServerCapabilities | null {
    return this._capabilities;
  }

  /**
   * Whether the server advertised a given capability.
   *
   * LSP treats `false` and absent the same way, so both are "no". Everything
   * else — `true`, or an options object — is "yes".
   */
  supports(capability: keyof LspServerCapabilities): boolean {
    const value = this._capabilities?.[capability];
    return value !== undefined && value !== null && value !== false;
  }

  /** The server's semantic-token legend, or null if it publishes no tokens. */
  get semanticTokensLegend(): LspSemanticTokensLegend | null {
    return this._capabilities?.semanticTokensProvider?.legend ?? null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * The lifecycle queue. `start`, `stop` and `restart` run one at a time.
   *
   * Every one of them is several `invoke`s with awaits between, and Tauri runs
   * commands concurrently — so two overlapping calls interleave on the Rust
   * side in whatever order the runtime picks. That is not hypothetical: the
   * workspace effect in App.tsx fires `stop()` from its cleanup without
   * awaiting it and the next effect calls `start()` immediately, so opening a
   * second folder could land `lsp_start` first and then have the late
   * `lsp_stop` tear down the transport the handshake was about to use. The
   * client then sent `initialize` into nothing, reported "LSP server not
   * running", and the UI sat on "Waiting for the language server" with no
   * server and no retry.
   */
  private queue: Promise<void> = Promise.resolve();

  /** Append `task` to the lifecycle queue and resolve with its outcome. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task);
    // The tail swallows the outcome so the queue itself can never reject: one
    // failed start would otherwise poison every call behind it, which is the
    // same "no way back" this queue exists to remove. The caller still gets the
    // rejection it is owed, from `run`.
    this.queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** Start the LSP server and run the initialize handshake. */
  start(workspacePath: string, options?: LspStartOptions): Promise<void> {
    return this.enqueue(() => this._start(workspacePath, options));
  }

  /** Stop the LSP server and reset all state. */
  stop(): Promise<void> {
    return this.enqueue(() => this._stop());
  }

  /**
   * Stop the running server and start the one settings now name.
   *
   * Both halves are needed: the Rust side re-reads the backend setting when it
   * starts a server, and the client has to redo the handshake because the new
   * backend advertises a different capability set. Both are now `start`'s,
   * which stops first — this stays as a name of its own because "restart the
   * language server" is what its two callers mean: the Settings backend switch,
   * and the `lsp.restart` command.
   */
  restart(workspacePath: string, options?: LspStartOptions): Promise<void> {
    return this.start(workspacePath, options);
  }

  private async _start(workspacePath: string, options?: LspStartOptions): Promise<void> {
    // Always from a stopped server. `lsp_start` returns `Ok(())` untouched when
    // it thinks one is already coming up, so starting on top of a session that
    // failed halfway through would hand the handshake to a server that is not
    // there.
    await this._stop();

    this._isReady = false;
    this._capabilities = null;
    this._backend = options?.backend ?? "";
    this._openDocuments.clear();
    this._pendingOpens.clear();
    this.rootUri = pathToUri(workspacePath);

    await invoke("lsp_start", { workspacePath });
    await this.listenForNotifications();
    await this.initialize(workspacePath, options?.initializationOptions ?? null);

    // Fully initialized — mark ready then flush any queued opens
    this._isReady = true;
    for (const [uri, text] of this._pendingOpens) {
      await this._sendDidOpen(uri, text);
    }
    this._pendingOpens.clear();

    // Only now do subscribers know what the server can do. Providers that
    // depend on the advertised legend (semantic tokens) cannot be registered
    // before this point.
    for (const handler of this.readyHandlers) {
      try {
        handler(this._capabilities ?? {});
      } catch (e) {
        console.error("LSP ready handler failed:", e);
      }
    }
  }

  private async _stop(): Promise<void> {
    this._isReady = false;
    this._capabilities = null;
    this._backend = "";
    this._openDocuments.clear();
    this._pendingOpens.clear();
    this.notificationUnlisten?.();
    this.notificationUnlisten = null;
    await invoke("lsp_stop");
  }

  /**
   * Register a handler that runs after each successful handshake — including
   * after a backend switch, so capability-dependent registrations can be
   * rebuilt. Returns an unlisten function.
   */
  onReady(handler: LspReadyHandler): () => void {
    this.readyHandlers.push(handler);
    if (this._isReady && this._capabilities) handler(this._capabilities);
    return () => {
      this.readyHandlers = this.readyHandlers.filter((h) => h !== handler);
    };
  }

  /**
   * Register a handler for LSP push notifications (e.g. publishDiagnostics).
   * Returns an unlisten function.
   */
  onNotification(handler: LspNotificationHandler): () => void {
    this.notificationHandlers.push(handler);
    return () => {
      this.notificationHandlers = this.notificationHandlers.filter((h) => h !== handler);
    };
  }

  private async listenForNotifications(): Promise<void> {
    this.notificationUnlisten?.();
    this.notificationUnlisten = await listen<Record<string, unknown>>(
      "lsp-notification",
      (event) => {
        const msg = event.payload;
        const method = msg["method"] as string | undefined;
        const params = msg["params"];
        const id = msg["id"];

        // Server-initiated request (has both id and method) — must respond
        if (id !== undefined && id !== null && method !== undefined) {
          this.handleServerRequest(id, method, params).catch(console.error);
          return;
        }

        // Regular push notification (no id)
        if (method) {
          for (const handler of this.notificationHandlers) {
            handler(method, params);
          }
        }
      },
    );
  }

  /**
   * Respond to server-initiated LSP requests.
   * LanguageServer.jl crashes if these go unanswered.
   */
  private async handleServerRequest(id: unknown, method: string, params: unknown): Promise<void> {
    let result: unknown = null;

    if (method === "workspace/configuration") {
      // Respond with null for each requested config item (use defaults)
      const items = (params as { items?: unknown[] })?.items ?? [];
      result = items.map(() => null);
    }
    // window/workDoneProgress/create, client/registerCapability,
    // workspace/semanticTokens/refresh, workspace/inlayHint/refresh, etc.
    // all expect null as an acknowledgment.

    await invoke("lsp_send_response", { id, result });
  }

  // ── LSP initialization handshake ─────────────────────────────────────────────

  private async initialize(workspacePath: string, initializationOptions: unknown): Promise<void> {
    const workspaceName = basename(workspacePath) || "workspace";
    const result = await invoke<{ capabilities?: LspServerCapabilities } | null>(
      "lsp_send_request",
      {
        method: "initialize",
        params: {
          processId: null,
          rootUri: this.rootUri,
          capabilities: CLIENT_CAPABILITIES,
          initializationOptions,
          workspaceFolders: [{ uri: this.rootUri, name: workspaceName }],
        },
      },
    );

    // What the server can actually do. Providers branch on this instead of
    // assuming a fixed feature set, because the backends differ.
    this._capabilities = result?.capabilities ?? {};

    // Send initialized notification (required by LSP spec after initialize response)
    await invoke("lsp_send_notification", {
      method: "initialized",
      params: {},
    });
  }

  /**
   * Push new settings to the server (`workspace/didChangeConfiguration`).
   *
   * Fatou re-reads its format style and lint rules from this payload, so
   * changing line width in Settings takes effect without a restart. A project
   * `fatou.toml` still shadows whatever is sent here — that is Fatou's
   * documented precedence, not a bug.
   */
  async didChangeConfiguration(settings: unknown): Promise<void> {
    if (!this._isReady) return;
    await invoke("lsp_send_notification", {
      method: "workspace/didChangeConfiguration",
      params: { settings },
    });
  }

  // ── Document synchronization ─────────────────────────────────────────────────

  /**
   * Notify LS.jl that a document was opened.
   * If LSP is not yet ready, queues the open for when it becomes ready.
   * Deduplicates — safe to call multiple times for the same URI.
   */
  async didOpen(uri: string, text: string): Promise<void> {
    // Prevent duplicate opens (LS.jl errors on duplicate didOpen)
    if (this._openDocuments.has(uri)) return;

    if (!this._isReady) {
      // Queue: will be flushed after initialize handshake completes
      this._pendingOpens.set(uri, text);
      return;
    }

    await this._sendDidOpen(uri, text);
  }

  private async _sendDidOpen(uri: string, text: string): Promise<void> {
    await invoke("lsp_send_notification", {
      method: "textDocument/didOpen",
      params: {
        textDocument: { uri, languageId: "julia", version: 1, text },
      },
    });
    this._openDocuments.add(uri);
  }

  /**
   * Notify LS.jl of a content change.
   * No-op if LSP is not ready or the document was never opened.
   */
  async didChange(uri: string, text: string, version: number): Promise<void> {
    if (!this._isReady || !this._openDocuments.has(uri)) return;

    await invoke("lsp_send_notification", {
      method: "textDocument/didChange",
      params: {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      },
    });
  }

  /**
   * Notify LS.jl that a document was closed.
   * Also removes it from the pending-open queue.
   */
  async didClose(uri: string): Promise<void> {
    // If it was queued but never opened on the server, just discard
    this._pendingOpens.delete(uri);
    if (!this._openDocuments.has(uri)) return;

    await invoke("lsp_send_notification", {
      method: "textDocument/didClose",
      params: { textDocument: { uri } },
    });
    this._openDocuments.delete(uri);
  }

  // ── Language features ─────────────────────────────────────────────────────────

  async getCompletions(uri: string, line: number, character: number): Promise<LspCompletionItem[]> {
    if (!this._isReady || !this._openDocuments.has(uri)) return [];

    const result = await invoke<LspCompletionList | LspCompletionItem[] | null>(
      "lsp_send_request",
      {
        method: "textDocument/completion",
        params: {
          textDocument: { uri },
          position: { line, character },
          context: { triggerKind: 1 },
        },
      },
    );
    if (!result) return [];
    if (Array.isArray(result)) return result;
    return result.items ?? [];
  }

  async getHover(uri: string, line: number, character: number): Promise<LspHover | null> {
    if (!this._isReady || !this._openDocuments.has(uri)) return null;

    return invoke<LspHover | null>("lsp_send_request", {
      method: "textDocument/hover",
      params: { textDocument: { uri }, position: { line, character } },
    });
  }

  async getDefinition(uri: string, line: number, character: number): Promise<LspLocation[]> {
    if (!this._isReady || !this._openDocuments.has(uri)) return [];

    const result = await invoke<LspLocation | LspLocation[] | null>("lsp_send_request", {
      method: "textDocument/definition",
      params: { textDocument: { uri }, position: { line, character } },
    });
    if (!result) return [];
    return Array.isArray(result) ? result : [result];
  }

  async getSignatureHelp(
    uri: string,
    line: number,
    character: number,
  ): Promise<LspSignatureHelp | null> {
    if (!this._isReady || !this._openDocuments.has(uri)) return null;

    return invoke<LspSignatureHelp | null>("lsp_send_request", {
      method: "textDocument/signatureHelp",
      params: {
        textDocument: { uri },
        position: { line, character },
        context: { triggerKind: 1 },
      },
    });
  }

  async getReferences(uri: string, line: number, character: number): Promise<LspLocation[]> {
    if (!this._isReady || !this._openDocuments.has(uri)) return [];

    const result = await invoke<LspLocation[] | null>("lsp_send_request", {
      method: "textDocument/references",
      params: {
        textDocument: { uri },
        position: { line, character },
        context: { includeDeclaration: true },
      },
    });
    return result ?? [];
  }

  async rename(
    uri: string,
    line: number,
    character: number,
    newName: string,
  ): Promise<LspWorkspaceEdit | null> {
    if (!this._isReady || !this._openDocuments.has(uri)) return null;

    return invoke<LspWorkspaceEdit | null>("lsp_send_request", {
      method: "textDocument/rename",
      params: {
        textDocument: { uri },
        position: { line, character },
        newName,
      },
    });
  }

  async prepareRename(uri: string, line: number, character: number): Promise<LspRange | null> {
    if (!this._isReady || !this._openDocuments.has(uri)) return null;

    return invoke<LspRange | null>("lsp_send_request", {
      method: "textDocument/prepareRename",
      params: {
        textDocument: { uri },
        position: { line, character },
      },
    });
  }

  async getCodeActions(
    uri: string,
    range: LspRange,
    diagnostics: LspDiagnostic[],
  ): Promise<LspCodeAction[]> {
    if (!this._isReady || !this._openDocuments.has(uri)) return [];

    const result = await invoke<LspCodeAction[] | null>("lsp_send_request", {
      method: "textDocument/codeAction",
      params: {
        textDocument: { uri },
        range,
        context: { diagnostics },
      },
    });
    return result ?? [];
  }

  async formatting(uri: string, tabSize: number, insertSpaces: boolean): Promise<LspTextEdit[]> {
    if (!this._isReady || !this._openDocuments.has(uri)) return [];

    const result = await invoke<LspTextEdit[] | null>("lsp_send_request", {
      method: "textDocument/formatting",
      params: {
        textDocument: { uri },
        options: { tabSize, insertSpaces },
      },
    });
    return result ?? [];
  }

  /** Format just a selection. Fatou supports this; LanguageServer.jl does not. */
  async rangeFormatting(
    uri: string,
    range: LspRange,
    tabSize: number,
    insertSpaces: boolean,
  ): Promise<LspTextEdit[]> {
    if (!this._isReady || !this._openDocuments.has(uri)) return [];

    const result = await invoke<LspTextEdit[] | null>("lsp_send_request", {
      method: "textDocument/rangeFormatting",
      params: {
        textDocument: { uri },
        range,
        options: { tabSize, insertSpaces },
      },
    });
    return result ?? [];
  }

  async getInlayHints(uri: string, range: LspRange): Promise<LspInlayHint[]> {
    if (!this._isReady || !this._openDocuments.has(uri)) return [];

    const result = await invoke<LspInlayHint[] | null>("lsp_send_request", {
      method: "textDocument/inlayHint",
      params: {
        textDocument: { uri },
        range,
      },
    });
    return result ?? [];
  }

  async getWorkspaceSymbols(query: string): Promise<any[] | null> {
    if (!this._isReady) return null;

    return invoke<any[] | null>("lsp_send_request", {
      method: "workspace/symbol",
      params: { query },
    });
  }

  async getDocumentSymbols(uri: string): Promise<any[] | null> {
    if (!this._isReady || !this._openDocuments.has(uri)) return null;

    return invoke<any[] | null>("lsp_send_request", {
      method: "textDocument/documentSymbol",
      params: { textDocument: { uri } },
    });
  }

  async getSemanticTokensFull(uri: string): Promise<LspSemanticTokens | null> {
    if (!this._isReady || !this._openDocuments.has(uri)) return null;

    return invoke<LspSemanticTokens | null>("lsp_send_request", {
      method: "textDocument/semanticTokens/full",
      params: { textDocument: { uri } },
    });
  }

  async prepareCallHierarchy(
    uri: string,
    line: number,
    character: number,
  ): Promise<LspCallHierarchyItem[]> {
    if (!this._isReady || !this._openDocuments.has(uri)) return [];

    const result = await invoke<LspCallHierarchyItem[] | null>("lsp_send_request", {
      method: "textDocument/prepareCallHierarchy",
      params: { textDocument: { uri }, position: { line, character } },
    });
    return result ?? [];
  }

  async callHierarchyIncomingCalls(
    item: LspCallHierarchyItem,
  ): Promise<LspCallHierarchyIncomingCall[]> {
    if (!this._isReady) return [];

    const result = await invoke<LspCallHierarchyIncomingCall[] | null>("lsp_send_request", {
      method: "callHierarchy/incomingCalls",
      params: { item },
    });
    return result ?? [];
  }

  async callHierarchyOutgoingCalls(
    item: LspCallHierarchyItem,
  ): Promise<LspCallHierarchyOutgoingCall[]> {
    if (!this._isReady) return [];

    const result = await invoke<LspCallHierarchyOutgoingCall[] | null>("lsp_send_request", {
      method: "callHierarchy/outgoingCalls",
      params: { item },
    });
    return result ?? [];
  }
}

// Module-level singleton — one client for the app lifetime
export const lspClient = new LspClient();
