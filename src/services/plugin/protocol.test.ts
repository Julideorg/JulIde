import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  isolationFailures,
  PluginRpcError,
  deserializeError,
  isEnvelope,
  isReadyPing,
  isRpcEvent,
  isRpcRequest,
  isRpcResponse,
  serializeError,
} from "./protocol";
import { PluginPermissionError } from "../pluginPermissions";

describe("envelope validation", () => {
  test("accepts the three well-formed shapes", () => {
    expect(isRpcRequest({ kind: "req", id: 0, method: "ipc.invoke" })).toBe(true);
    expect(isRpcResponse({ kind: "res", id: 1, ok: true, value: 42 })).toBe(true);
    expect(isRpcEvent({ kind: "evt", name: "view.visibility", payload: { visible: true } })).toBe(
      true,
    );
  });

  test("rejects anything that is not a plain object", () => {
    // Everything arriving here crossed a trust boundary, so `typeof x === "object"`
    // is not the question — what its prototype is, is.
    for (const v of [null, undefined, 42, "req", true, [], new Date(), new Map()]) {
      expect(isEnvelope(v), String(v)).toBe(false);
    }
  });

  test("rejects an object whose prototype was tampered with", () => {
    const hostile = Object.create({ kind: "req", id: 0, method: "ipc.invoke" }) as unknown;
    expect(isEnvelope(hostile)).toBe(false);
  });

  test("rejects an unknown kind", () => {
    expect(isEnvelope({ kind: "exec", id: 0, method: "x" })).toBe(false);
    expect(isEnvelope({ id: 0, method: "x" })).toBe(false);
  });

  test("rejects correlation ids that are not safe non-negative integers", () => {
    for (const id of [-1, 1.5, NaN, Infinity, "1", null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(isRpcRequest({ kind: "req", id, method: "m" }), String(id)).toBe(false);
    }
  });

  test("rejects an empty or non-string method", () => {
    expect(isRpcRequest({ kind: "req", id: 0, method: "" })).toBe(false);
    expect(isRpcRequest({ kind: "req", id: 0, method: 7 })).toBe(false);
  });

  test("a failed response must carry an error", () => {
    // Otherwise a frame sends {ok:false} and the awaiting caller rejects with undefined.
    expect(isRpcResponse({ kind: "res", id: 1, ok: false })).toBe(false);
    expect(
      isRpcResponse({
        kind: "res",
        id: 1,
        ok: false,
        error: { code: "internal", name: "Error", message: "boom" },
      }),
    ).toBe(true);
  });

  test("an event's subscription id is validated when present", () => {
    expect(isRpcEvent({ kind: "evt", name: "x", subscription: 3 })).toBe(true);
    expect(isRpcEvent({ kind: "evt", name: "x", subscription: -3 })).toBe(false);
    expect(isRpcEvent({ kind: "evt", name: "x", subscription: "3" })).toBe(false);
  });
});

describe("ready ping", () => {
  test("accepts a well-formed ping", () => {
    expect(isReadyPing({ julidePluginReady: true, frameId: "abc", protocolVersion: 2 })).toBe(true);
  });

  test("rejects a ping with no frame id", () => {
    // The frame id is what ties the ping to a frame the host actually created.
    expect(isReadyPing({ julidePluginReady: true, frameId: "", protocolVersion: 2 })).toBe(false);
    expect(isReadyPing({ julidePluginReady: true, protocolVersion: 2 })).toBe(false);
  });

  test("a truthy-but-not-true marker is not a ping", () => {
    expect(isReadyPing({ julidePluginReady: 1, frameId: "abc", protocolVersion: 2 })).toBe(false);
  });

  test("the protocol version is fixed at 2", () => {
    expect(PROTOCOL_VERSION).toBe(2);
  });
});

describe("error serialization", () => {
  test("a permission denial keeps the permission, the target, and the exact message", () => {
    // The message names the missing permission and says where to re-approve it. A
    // plugin author reads that string; rewording it on the way out would mean two
    // versions of the same sentence.
    const original = new PluginPermissionError("my-plugin", "julia_run", "julia:run");
    const wire = serializeError(original);

    expect(wire.code).toBe("permission-denied");
    expect(wire.name).toBe("PluginPermissionError");
    expect(wire.permission).toBe("julia:run");
    expect(wire.target).toBe("julia_run");
    expect(wire.message).toBe(original.message);
  });

  test("a denial with no named permission is forbidden-target, not permission-denied", () => {
    // "You did not ask for this permission" and "no permission could ever allow this"
    // are different facts, and a plugin should be able to tell them apart.
    const original = new PluginPermissionError("p", "plugin_grants_save", null);
    expect(serializeError(original).code).toBe("forbidden-target");
  });

  test("round-trips into something that still looks like the original", () => {
    const original = new PluginPermissionError("p", "fs_write_file", "workspace:write");
    const revived = deserializeError(serializeError(original));

    expect(revived).toBeInstanceOf(PluginRpcError);
    expect(revived.name).toBe("PluginPermissionError");
    expect(revived.code).toBe("permission-denied");
    expect(revived.permission).toBe("workspace:write");
    expect(revived.message).toBe(original.message);
  });

  test("an ordinary error becomes internal", () => {
    const wire = serializeError(new Error("something broke"));
    expect(wire.code).toBe("internal");
    expect(wire.message).toBe("something broke");
    expect(wire.permission).toBeNull();
  });

  test("a thrown non-error still produces a usable envelope", () => {
    // Plugin code can `throw "nope"`, and the dispatcher must not itself throw.
    expect(serializeError("nope").message).toBe("nope");
    expect(serializeError(undefined).message).toBe("undefined");
    expect(serializeError({ toString: () => "weird" }).message).toBe("weird");
  });

  test("an explicit code on the error wins", () => {
    const e = Object.assign(new Error("nope"), { code: "wrong-role" });
    expect(serializeError(e).code).toBe("wrong-role");
  });

  test("an unrecognised code falls back rather than passing through", () => {
    // Otherwise a plugin could induce an error carrying an arbitrary `code` string
    // and callers switching on it would hit no branch.
    const e = Object.assign(new Error("nope"), { code: "definitely-not-a-code" });
    expect(serializeError(e).code).toBe("internal");
  });

  test("the caller can pick the fallback code", () => {
    expect(serializeError(new Error("slow"), "timeout").code).toBe("timeout");
  });
});

describe("isolationFailures", () => {
  const intact = {
    tauriInternals: "undefined",
    opaqueOrigin: true,
    storageBlocked: true,
    cspApplied: true,
  };

  test("an intact sandbox reports nothing", () => {
    expect(isolationFailures(intact)).toEqual([]);
  });

  test("a reachable IPC bridge is the one that matters most", () => {
    // If this is ever true on a shipped platform, plugins have full ambient access and
    // every permission check above is decoration.
    expect(isolationFailures({ ...intact, tauriInternals: "object" })[0]).toContain(
      "IPC bridge is reachable",
    );
  });

  test("each missing property is named", () => {
    expect(isolationFailures({ ...intact, opaqueOrigin: false })[0]).toContain("opaque origin");
    expect(isolationFailures({ ...intact, storageBlocked: false })[0]).toContain("storage");
    expect(isolationFailures({ ...intact, cspApplied: false })[0]).toContain(
      "Content-Security-Policy",
    );
  });

  test("several failures are all reported, not just the first", () => {
    // A platform that gets one of these wrong usually gets more than one wrong, and a
    // bug report is worth more when it lists all of them.
    expect(
      isolationFailures({
        tauriInternals: "object",
        opaqueOrigin: false,
        storageBlocked: false,
        cspApplied: false,
      }),
    ).toHaveLength(4);
  });

  test("no report at all is a failure, not a pass", () => {
    // Otherwise a frame that simply omits the field would be treated as isolated —
    // failing open on exactly the check that exists to fail closed.
    expect(isolationFailures(undefined)).toHaveLength(1);
  });
});
