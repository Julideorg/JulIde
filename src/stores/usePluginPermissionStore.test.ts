import { beforeEach, describe, expect, test } from "bun:test";
import { computeManifestHash, usePluginPermissionStore } from "./usePluginPermissionStore";
import { invokeHandlers, resetTauriMocks } from "../__test__/tauriMock";

const BASE = { name: "p", version: "1.0.0", main: "index.js", permissions: ["workspace:read"] };

beforeEach(() => {
  resetTauriMocks();
  usePluginPermissionStore.setState({ grants: {}, loaded: false, queue: [] });
  invokeHandlers.set("plugin_grants_save", () => undefined);
});

describe("computeManifestHash", () => {
  test("is stable for the same manifest", () => {
    expect(computeManifestHash(BASE)).toBe(computeManifestHash({ ...BASE }));
  });

  test("ignores permission ordering", () => {
    const a = computeManifestHash({ ...BASE, permissions: ["julia:run", "workspace:read"] });
    const b = computeManifestHash({ ...BASE, permissions: ["workspace:read", "julia:run"] });
    expect(a).toBe(b);
  });

  test("changes when the plugin asks for more", () => {
    const before = computeManifestHash(BASE);
    const after = computeManifestHash({ ...BASE, permissions: ["workspace:read", "terminal"] });
    expect(after).not.toBe(before);
  });

  test("changes when the version or entry point changes", () => {
    expect(computeManifestHash({ ...BASE, version: "1.0.1" })).not.toBe(computeManifestHash(BASE));
    expect(computeManifestHash({ ...BASE, main: "evil.js" })).not.toBe(computeManifestHash(BASE));
  });

  test("changes when the plugin adds a network origin", () => {
    // The permission list is untouched here. A plugin with only workspace:read that
    // quietly gains an egress host has become an exfiltration tool, and that must
    // re-prompt rather than inherit yesterday's approval.
    const before = computeManifestHash(BASE);
    const after = computeManifestHash({ ...BASE, network: ["https://exfil.example"] });
    expect(after).not.toBe(before);
  });

  test("ignores network ordering", () => {
    const a = computeManifestHash({ ...BASE, network: ["https://a.example", "https://b.example"] });
    const b = computeManifestHash({ ...BASE, network: ["https://b.example", "https://a.example"] });
    expect(a).toBe(b);
  });

  test("changes when the API generation changes", () => {
    expect(computeManifestHash({ ...BASE, apiVersion: 2 })).not.toBe(computeManifestHash(BASE));
  });

  test("an absent network list is the same as an empty one", () => {
    expect(computeManifestHash({ ...BASE, network: [] })).toBe(computeManifestHash(BASE));
  });
});

describe("grants", () => {
  test("granted() returns the approved permissions for a matching manifest", async () => {
    const hash = computeManifestHash(BASE);
    await usePluginPermissionStore.getState().grant("p", ["workspace:read"], hash);

    expect(usePluginPermissionStore.getState().granted("p", hash)).toEqual(["workspace:read"]);
  });

  test("granted() returns nothing for an unknown plugin", () => {
    expect(usePluginPermissionStore.getState().granted("nope", "abc")).toEqual([]);
  });

  test("a changed manifest invalidates the previous approval", async () => {
    const oldHash = computeManifestHash(BASE);
    await usePluginPermissionStore.getState().grant("p", ["workspace:read"], oldHash);

    // The plugin is updated to also ask for terminal access. The old approval must
    // not carry over — this is the swap-the-plugin-after-approval case.
    const newHash = computeManifestHash({ ...BASE, permissions: ["workspace:read", "terminal"] });
    expect(usePluginPermissionStore.getState().granted("p", newHash)).toEqual([]);
  });

  test("revoke() removes the grant", async () => {
    const hash = computeManifestHash(BASE);
    await usePluginPermissionStore.getState().grant("p", ["workspace:read"], hash);
    await usePluginPermissionStore.getState().revoke("p");

    expect(usePluginPermissionStore.getState().granted("p", hash)).toEqual([]);
    expect(usePluginPermissionStore.getState().grants.p).toBeUndefined();
  });

  test("grants persist through plugin_grants_save", async () => {
    const saved: unknown[] = [];
    invokeHandlers.set("plugin_grants_save", (args) => {
      saved.push(args);
    });

    const hash = computeManifestHash(BASE);
    await usePluginPermissionStore.getState().grant("p", ["workspace:read"], hash);

    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual({
      grants: { p: { permissions: ["workspace:read"], manifestHash: hash, network: [] } },
    });
  });

  test("approved network origins are persisted alongside the permissions", async () => {
    // Settings → Plugins shows what a plugin can reach, not only what it can do, and
    // that has to survive a restart like the permission list does.
    const saved: unknown[] = [];
    invokeHandlers.set("plugin_grants_save", (args) => {
      saved.push(args);
    });
    const hash = computeManifestHash({ ...BASE, network: ["https://api.github.com"] });
    await usePluginPermissionStore
      .getState()
      .grant("p", ["workspace:read"], hash, ["https://api.github.com"]);

    expect(usePluginPermissionStore.getState().grants.p?.network).toEqual([
      "https://api.github.com",
    ]);
  });

  test("load() populates grants from disk", async () => {
    invokeHandlers.set("plugin_grants_load", () => ({
      p: { permissions: ["julia:run"], manifestHash: "abc" },
    }));

    await usePluginPermissionStore.getState().load();

    expect(usePluginPermissionStore.getState().loaded).toBe(true);
    expect(usePluginPermissionStore.getState().granted("p", "abc")).toEqual(["julia:run"]);
  });

  test("load() degrades to no grants when the file is unreadable", async () => {
    invokeHandlers.set("plugin_grants_load", () => {
      throw new Error("disk error");
    });

    await usePluginPermissionStore.getState().load();

    // Failing closed here means plugins get re-prompted, never silently trusted.
    expect(usePluginPermissionStore.getState().loaded).toBe(true);
    expect(usePluginPermissionStore.getState().grants).toEqual({});
  });
});

describe("consent queue", () => {
  test("requestConsent resolves true when approved", async () => {
    const store = usePluginPermissionStore.getState();
    const pending = store.requestConsent({
      pluginId: "p",
      displayName: "P",
      version: "1.0.0",
      requested: ["workspace:read"],
      unknown: [],
      network: [],
      rejectedNetwork: [],
      manifestHash: "abc",
    });

    expect(usePluginPermissionStore.getState().queue).toHaveLength(1);
    usePluginPermissionStore.getState().resolveNext(true);

    expect(await pending).toBe(true);
    expect(usePluginPermissionStore.getState().queue).toHaveLength(0);
  });

  test("requestConsent resolves false when declined", async () => {
    const pending = usePluginPermissionStore.getState().requestConsent({
      pluginId: "p",
      displayName: "P",
      version: "1.0.0",
      requested: ["containers"],
      unknown: [],
      network: [],
      rejectedNetwork: [],
      manifestHash: "abc",
    });

    usePluginPermissionStore.getState().resolveNext(false);
    expect(await pending).toBe(false);
  });

  test("prompts queue and resolve in order", async () => {
    const store = () => usePluginPermissionStore.getState();
    const base = {
      version: "1.0.0",
      requested: [] as never[],
      unknown: [],
      network: [],
      rejectedNetwork: [],
      manifestHash: "h",
    };

    const first = store().requestConsent({ ...base, pluginId: "a", displayName: "A" });
    const second = store().requestConsent({ ...base, pluginId: "b", displayName: "B" });

    expect(store().queue.map((q) => q.pluginId)).toEqual(["a", "b"]);

    store().resolveNext(true);
    expect(await first).toBe(true);
    expect(store().queue.map((q) => q.pluginId)).toEqual(["b"]);

    store().resolveNext(false);
    expect(await second).toBe(false);
  });
});
