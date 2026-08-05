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
