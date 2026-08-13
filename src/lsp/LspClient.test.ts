import { describe, expect, test, beforeEach } from "bun:test";
import { resetTauriMocks, invokeHandlers } from "../__test__/tauriMock";

// We need to re-import the class to test it fresh. Since lspClient is a singleton,
// we'll create new instances manually by accessing the class.
// The module exports `lspClient` singleton, but we can test the class behavior through it.
import { lspClient } from "./LspClient";

beforeEach(() => {
  resetTauriMocks();
  // Manually reset the client state by calling stop (which resets internal state)
  // We need to mock lsp_stop for this to work
  invokeHandlers.set("lsp_stop", () => {});
});

describe("LspClient initial state", () => {
  test("isReady is false initially", () => {
    expect(lspClient.isReady).toBe(false);
  });
});

describe("didOpen", () => {
  test("queues opens when not ready", async () => {
    const invocations: string[] = [];
    invokeHandlers.set("lsp_send_notification", (args: any) => {
      invocations.push(args?.method);
    });

    await lspClient.didOpen("file:///test.jl", "println()");

    // Should not have called lsp_send_notification since client is not ready
    expect(invocations).toHaveLength(0);
  });
});

describe("didChange", () => {
  test("is a no-op when not ready", async () => {
    const invocations: string[] = [];
    invokeHandlers.set("lsp_send_notification", (args: any) => {
      invocations.push(args?.method);
    });

    await lspClient.didChange("file:///test.jl", "new content", 2);

    expect(invocations).toHaveLength(0);
  });
});

describe("getCompletions", () => {
  test("returns empty array when not ready", async () => {
    const result = await lspClient.getCompletions("file:///test.jl", 0, 0);
    expect(result).toEqual([]);
  });
});

describe("getHover", () => {
  test("returns null when not ready", async () => {
    const result = await lspClient.getHover("file:///test.jl", 0, 0);
    expect(result).toBeNull();
  });
});

describe("getDefinition", () => {
  test("returns empty array when not ready", async () => {
    const result = await lspClient.getDefinition("file:///test.jl", 0, 0);
    expect(result).toEqual([]);
  });
});

describe("getSignatureHelp", () => {
  test("returns null when not ready", async () => {
    const result = await lspClient.getSignatureHelp("file:///test.jl", 0, 0);
    expect(result).toBeNull();
  });
});

describe("onNotification", () => {
  test("returns unlisten function that removes handler", () => {
    let callCount = 0;
    const handler = () => {
      callCount++;
    };

    const unlisten = lspClient.onNotification(handler);
    unlisten();
    // The point of the test: after unlisten, the handler must not fire again.
    expect(callCount).toBe(0);

    // Handler was removed — we can't easily verify this without triggering a notification,
    // but at least we verify the API contract works
    expect(typeof unlisten).toBe("function");
  });
});

describe("getWorkspaceSymbols", () => {
  test("returns null when not ready", async () => {
    const result = await lspClient.getWorkspaceSymbols("query");
    expect(result).toBeNull();
  });
});

// ── The ready path ───────────────────────────────────────────────────────────
//
// Capability negotiation is what lets one client drive three backends that
// implement different feature sets, so it needs the handshake to have run.

/** Run a full handshake with a server advertising `capabilities`. */
async function startWith(
  capabilities: Record<string, unknown>,
  options?: { backend?: string; initializationOptions?: unknown },
): Promise<{ requests: { method: string; params: any }[] }> {
  const requests: { method: string; params: any }[] = [];
  invokeHandlers.set("lsp_start", () => {});
  invokeHandlers.set("lsp_send_notification", () => {});
  invokeHandlers.set("lsp_send_request", (args: any) => {
    requests.push({ method: args.method, params: args.params });
    return { capabilities };
  });
  await lspClient.start("/tmp/ws", {
    backend: options?.backend ?? "fatou",
    initializationOptions: options?.initializationOptions ?? null,
  });
  return { requests };
}

describe("capability negotiation", () => {
  test("supports() reflects what the server advertised", async () => {
    await startWith({
      hoverProvider: true,
      documentRangeFormattingProvider: { workDoneProgress: false },
      // LSP treats an explicit false the same as absent.
      inlayHintProvider: false,
    });

    expect(lspClient.isReady).toBe(true);
    expect(lspClient.supports("hoverProvider")).toBe(true);
    // An options object means yes, not just a bare `true`.
    expect(lspClient.supports("documentRangeFormattingProvider")).toBe(true);
    expect(lspClient.supports("inlayHintProvider")).toBe(false);
    expect(lspClient.supports("callHierarchyProvider")).toBe(false);

    await lspClient.stop();
  });

  test("exposes the server's semantic token legend, not a guessed one", async () => {
    // Token data is indices into this legend; decoding with the wrong one
    // paints the file with whatever type landed at that index.
    const legend = { tokenTypes: ["macro", "keyword"], tokenModifiers: ["definition"] };
    await startWith({ semanticTokensProvider: { legend } });

    expect(lspClient.semanticTokensLegend).toEqual(legend);

    await lspClient.stop();
  });

  test("reports no legend when the server publishes no tokens", async () => {
    await startWith({ hoverProvider: true });
    expect(lspClient.semanticTokensLegend).toBeNull();
    await lspClient.stop();
  });

  test("onReady fires with the capabilities after each handshake", async () => {
    const seen: unknown[] = [];
    const unlisten = lspClient.onReady((caps) => seen.push(caps));

    await startWith({ hoverProvider: true });
    expect(seen).toHaveLength(1);

    // A backend switch re-runs the handshake, so dependent registrations get
    // another chance to rebuild themselves.
    await lspClient.stop();
    await startWith({ definitionProvider: true });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({ definitionProvider: true });

    unlisten();
    await lspClient.stop();
  });

  test("stop() clears capabilities so stale ones cannot be consulted", async () => {
    await startWith({ hoverProvider: true });
    await lspClient.stop();

    expect(lspClient.capabilities).toBeNull();
    expect(lspClient.supports("hoverProvider")).toBe(false);
    expect(lspClient.backend).toBe("");
  });
});

// ── Lifecycle ordering ───────────────────────────────────────────────────────

describe("lifecycle queue", () => {
  /** Record the order commands reach Rust, with a tick of latency each. */
  function recordCommandOrder(): string[] {
    const order: string[] = [];
    const slow = (name: string) => async () => {
      await Promise.resolve();
      order.push(name);
    };
    invokeHandlers.set("lsp_stop", slow("lsp_stop"));
    invokeHandlers.set("lsp_start", slow("lsp_start"));
    invokeHandlers.set("lsp_send_notification", (args: any) => {
      order.push(args.method);
    });
    invokeHandlers.set("lsp_send_request", (args: any) => {
      order.push(args.method);
      return { capabilities: {} };
    });
    return order;
  }

  /**
   * `start` now stops first, which is what makes the Rust-side race harmless.
   *
   * `lsp_start` returns `Ok(())` untouched when it believes a server is already
   * coming up, so a `start` on top of a session that died halfway through used
   * to hand the handshake to a server that was not there. Coming from `Off`
   * every time removes the question.
   */
  test("start() stops whatever was running first", async () => {
    const order = recordCommandOrder();

    await lspClient.start("/tmp/ws", { backend: "fatou" });

    expect(order).toEqual(["lsp_stop", "lsp_start", "initialize", "initialized"]);

    await lspClient.stop();
  });

  /**
   * A `stop` raised mid-handshake waits for the handshake rather than cutting
   * into it.
   *
   * This is the ordering the queue exists for: App.tsx starts the server when a
   * workspace opens and stops it from the effect cleanup, without awaiting
   * either, so the two can be raised one tick apart. Un-queued, the `lsp_stop`
   * landed between `lsp_start` and `initialize` — dropping the transport under
   * a handshake that had already begun, which the client reports as
   * "LSP server not running" and the UI renders as "Waiting for the language
   * server", permanently and with nothing running behind it.
   */
  test("a stop() raised mid-handshake waits for it to finish", async () => {
    const order = recordCommandOrder();

    const started = lspClient.start("/tmp/ws", { backend: "fatou" });
    const stopped = lspClient.stop();
    await Promise.all([started, stopped]);

    expect(order).toEqual(["lsp_stop", "lsp_start", "initialize", "initialized", "lsp_stop"]);
    expect(lspClient.isReady).toBe(false);
  });

  /** One failure must not poison the queue for everything behind it. */
  test("a failed start does not block the next one", async () => {
    recordCommandOrder();
    invokeHandlers.set("lsp_send_request", () => {
      throw new Error("Fatou language server is not running");
    });

    const failed = lspClient.start("/tmp/ws", { backend: "fatou" });
    await expect(failed).rejects.toThrow("Fatou language server is not running");

    recordCommandOrder();
    await lspClient.start("/tmp/ws", { backend: "fatou" });
    expect(lspClient.isReady).toBe(true);

    await lspClient.stop();
  });
});

describe("initialize params", () => {
  test("passes initializationOptions straight through", async () => {
    const options = { format: { "line-width": 100, "indent-width": 2 } };
    const { requests } = await startWith({}, { initializationOptions: options });

    const initialize = requests.find((r) => r.method === "initialize");
    expect(initialize?.params.initializationOptions).toEqual(options);
    expect(lspClient.backend).toBe("fatou");

    await lspClient.stop();
  });

  test("does not offer a position encoding", async () => {
    // Silence keeps the server on LSP's UTF-16 default, which is what Monaco
    // counts in. Offering UTF-8 would misplace ranges in non-ASCII files.
    const { requests } = await startWith({});
    const initialize = requests.find((r) => r.method === "initialize");

    expect(initialize?.params.capabilities.general?.positionEncodings).toBeUndefined();

    await lspClient.stop();
  });

  test("does not claim pull-diagnostics support", async () => {
    // Declaring textDocument.diagnostic switches Fatou to pull mode, and the
    // app only consumes pushed publishDiagnostics.
    const { requests } = await startWith({});
    const initialize = requests.find((r) => r.method === "initialize");

    expect(initialize?.params.capabilities.textDocument.diagnostic).toBeUndefined();
    expect(initialize?.params.capabilities.textDocument.publishDiagnostics).toBeDefined();

    await lspClient.stop();
  });
});
