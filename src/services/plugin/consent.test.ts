import { describe, expect, test } from "bun:test";
import { resolveGrant, type ConsentStore } from "./consent";
import { parseManifest, type ParsedManifest } from "./manifest";
import type { PluginPermission } from "../pluginPermissions";

function manifestOf(overrides: Record<string, unknown> = {}): ParsedManifest {
  const r = parseManifest({
    apiVersion: 2,
    name: "p",
    version: "1.0.0",
    displayName: "P",
    main: "index.js",
    ...overrides,
  });
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.manifest;
}

/** A store that records what it was asked and answers however the test says. */
function makeStore(opts: { stored?: PluginPermission[]; approve?: boolean } = {}) {
  const prompts: { requested: PluginPermission[]; network: string[]; rejectedNetwork: string[] }[] =
    [];
  const grants: { permissions: PluginPermission[]; network?: string[] }[] = [];
  const store: ConsentStore = {
    granted: () => opts.stored ?? [],
    hasGrant: () => opts.stored !== undefined,
    grant: async (_id, permissions, _hash, network) => {
      grants.push({ permissions, network });
    },
    requestConsent: async (req) => {
      prompts.push({
        requested: req.requested,
        network: req.network,
        rejectedNetwork: req.rejectedNetwork,
      });
      return opts.approve ?? false;
    },
  };
  return { store, prompts, grants };
}

const reports: string[] = [];
const report = (t: string) => reports.push(t);

describe("a plugin that asks for nothing", () => {
  test("loads without a prompt", async () => {
    const { store, prompts } = makeStore();
    const result = await resolveGrant(manifestOf(), "h", store, report);
    expect(result).toEqual({ granted: [], manifestHash: "h" });
    expect(prompts).toHaveLength(0);
  });

  test("but is prompted if it wants the network", async () => {
    // Egress is a grant on its own. A plugin with no permissions that can post
    // whatever it scrapes to a host is not a plugin that needs no approval.
    const { store, prompts } = makeStore({ approve: true });
    const m = manifestOf({ network: ["https://api.example.com"] });

    const result = await resolveGrant(m, "h", store, report);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.network).toEqual(["api.example.com"]);
    expect(result).not.toBeNull();
  });

  test("unknown permissions are reported and dropped", async () => {
    reports.length = 0;
    const { store } = makeStore();
    await resolveGrant(manifestOf({ permissions: ["not-a-permission"] }), "h", store, report);
    expect(reports.join()).toContain("not-a-permission");
  });
});

describe("prompting", () => {
  test("declining yields null and stores nothing", async () => {
    const { store, grants } = makeStore({ approve: false });
    const m = manifestOf({ permissions: ["julia:run"] });

    expect(await resolveGrant(m, "h", store, report)).toBeNull();
    expect(grants).toHaveLength(0);
  });

  test("approving stores the permissions and the approved origins", async () => {
    const { store, grants } = makeStore({ approve: true });
    const m = manifestOf({
      permissions: ["julia:run"],
      network: ["https://api.example.com"],
    });

    const result = await resolveGrant(m, "h", store, report);

    expect(result?.granted).toEqual(["julia:run"]);
    expect(grants).toEqual([{ permissions: ["julia:run"], network: ["https://api.example.com"] }]);
  });

  test("rejected network entries are shown to the user, not hidden", async () => {
    const { store, prompts } = makeStore({ approve: true });
    const m = manifestOf({
      permissions: ["julia:run"],
      network: ["https://*.evil.com", "https://ok.example.com"],
    });

    await resolveGrant(m, "h", store, report);

    expect(prompts[0]!.network).toEqual(["ok.example.com"]);
    expect(prompts[0]!.rejectedNetwork).toEqual(["https://*.evil.com"]);
  });
});

describe("stored grants", () => {
  test("a covering grant skips the prompt", async () => {
    const { store, prompts } = makeStore({ stored: ["julia:run"] });
    const result = await resolveGrant(
      manifestOf({ permissions: ["julia:run"] }),
      "h",
      store,
      report,
    );

    expect(prompts).toHaveLength(0);
    expect(result?.granted).toEqual(["julia:run"]);
  });

  test("a grant that does not cover the request re-prompts", async () => {
    // The old check compared lengths. ["terminal"] against a request for
    // ["julia:run"] is the same length and covers nothing.
    const { store, prompts } = makeStore({ stored: ["terminal"], approve: false });
    expect(
      await resolveGrant(manifestOf({ permissions: ["julia:run"] }), "h", store, report),
    ).toBeNull();
    expect(prompts).toHaveLength(1);
  });

  test("a partially covering grant re-prompts", async () => {
    const { store, prompts } = makeStore({ stored: ["julia:run"], approve: false });
    const m = manifestOf({ permissions: ["julia:run", "git:credentials"] });

    await resolveGrant(m, "h", store, report);
    expect(prompts).toHaveLength(1);
  });

  test("a stale grant cannot confer more than the manifest now declares", async () => {
    // The stored list is never handed back; `requested` is. So a grant recorded when
    // the plugin asked for more does not keep giving it more.
    const { store } = makeStore({ stored: ["julia:run", "terminal", "git:credentials"] });
    const result = await resolveGrant(
      manifestOf({ permissions: ["julia:run"] }),
      "h",
      store,
      report,
    );
    expect(result?.granted).toEqual(["julia:run"]);
  });
});
