import { beforeEach, describe, expect, test } from "bun:test";
import {
  effectiveRevocation,
  pluginRevocations,
  satisfiesRange,
  type RevocationFeed,
} from "./revocations";
import { invokeHandlers, resetTauriMocks } from "../../__test__/tauriMock";

const feed = (entries: Partial<RevocationFeed["entries"][number]>[]): RevocationFeed => ({
  schemaVersion: 1,
  serial: 1,
  generatedAt: "2026-08-09T00:00:00Z",
  entries: entries.map((e) => ({
    plugin: "julia-fmt",
    versions: "1.1.1",
    action: "disable" as const,
    severity: "critical" as const,
    reason: "deletes files",
    ...e,
  })),
});

beforeEach(() => {
  resetTauriMocks();
  pluginRevocations.setFeed(null);
});

describe("satisfiesRange", () => {
  test("an exact version", () => {
    expect(satisfiesRange("1.1.1", "1.1.1")).toBe(true);
    expect(satisfiesRange("1.1.0", "1.1.1")).toBe(false);
  });

  test("a wildcard covers everything", () => {
    expect(satisfiesRange("9.9.9", "*")).toBe(true);
  });

  test("comparison operators", () => {
    expect(satisfiesRange("1.0.0", "<=2.3.4")).toBe(true);
    expect(satisfiesRange("3.0.0", "<=2.3.4")).toBe(false);
    expect(satisfiesRange("2.0.0", ">=1.0.0")).toBe(true);
    expect(satisfiesRange("1.0.0", ">1.0.0")).toBe(false);
  });

  test("compares numerically, not lexically", () => {
    // "0.10.0" sorts before "0.9.0" as a string, which is how a downgrade gets treated
    // as an upgrade — and how an advisory misses the versions it meant to cover.
    expect(satisfiesRange("0.10.0", ">=0.9.0")).toBe(true);
    expect(satisfiesRange("0.9.0", ">=0.10.0")).toBe(false);
  });

  test("caret pins the minor on 0.x", () => {
    expect(satisfiesRange("0.4.9", "^0.4.0")).toBe(true);
    expect(satisfiesRange("0.5.0", "^0.4.0")).toBe(false);
    expect(satisfiesRange("1.9.0", "^1.2.0")).toBe(true);
  });

  test("tilde pins the minor everywhere", () => {
    expect(satisfiesRange("1.2.9", "~1.2.0")).toBe(true);
    expect(satisfiesRange("1.3.0", "~1.2.0")).toBe(false);
  });

  test("alternation", () => {
    expect(satisfiesRange("1.0.0", "1.0.0 || 2.0.0")).toBe(true);
    expect(satisfiesRange("2.0.0", "1.0.0 || 2.0.0")).toBe(true);
    expect(satisfiesRange("3.0.0", "1.0.0 || 2.0.0")).toBe(false);
  });

  test("an unparseable range matches nothing", () => {
    // An advisory nobody can parse must not silently match everything — that would
    // disable every version of a plugin over a typo.
    for (const range of ["", "not a range", ">=abc", "1.x", "^", ">= 1.0"]) {
      expect(satisfiesRange("1.0.0", range), range).toBe(false);
    }
  });

  test("an unparseable version matches nothing", () => {
    expect(satisfiesRange("not-a-version", "*")).toBe(true); // wildcard is version-free
    expect(satisfiesRange("not-a-version", ">=1.0.0")).toBe(false);
  });
});

describe("effectiveRevocation", () => {
  test("null when there is no feed", () => {
    expect(effectiveRevocation(null, "julia-fmt", "1.1.1")).toBeNull();
  });

  test("matches the named plugin only", () => {
    expect(effectiveRevocation(feed([{}]), "julia-fmt", "1.1.1")).not.toBeNull();
    expect(effectiveRevocation(feed([{}]), "other", "1.1.1")).toBeNull();
  });

  test("disable wins over warn", () => {
    const f = feed([
      { versions: "*", action: "warn", severity: "low" },
      { versions: "*", action: "disable" },
    ]);
    expect(effectiveRevocation(f, "julia-fmt", "1.0.0")?.action).toBe("disable");
  });
});

describe("the service fails open", () => {
  test("a fetch error leaves plugins loadable", async () => {
    invokeHandlers.set("marketplace_fetch_revocations", () => {
      throw new Error("network unreachable");
    });

    await pluginRevocations.refresh();

    expect(pluginRevocations.isRevoked("julia-fmt", "1.1.1")).toBeNull();
    expect(pluginRevocations.error()).toContain("network unreachable");
  });

  test("a verification failure keeps the last verified feed rather than clearing it", async () => {
    // The Rust side already refused the document. Dropping what we had would let an
    // attacker un-revoke by serving something that fails to verify.
    invokeHandlers.set("marketplace_fetch_revocations", () => feed([{}]));
    await pluginRevocations.refresh();
    expect(pluginRevocations.isRevoked("julia-fmt", "1.1.1")).not.toBeNull();

    invokeHandlers.set("marketplace_fetch_revocations", () => {
      throw new Error("signature verification failed");
    });
    await pluginRevocations.refresh({ force: true });

    expect(pluginRevocations.isRevoked("julia-fmt", "1.1.1")).not.toBeNull();
    expect(pluginRevocations.error()).toContain("signature");
  });

  test("a null feed is not mistaken for an empty one", async () => {
    invokeHandlers.set("marketplace_fetch_revocations", () => feed([{}]));
    await pluginRevocations.refresh();

    // The Rust side returns null when it has nothing trustworthy — that must not wipe
    // what was already verified.
    invokeHandlers.set("marketplace_fetch_revocations", () => null);
    await pluginRevocations.refresh({ force: true });

    expect(pluginRevocations.isRevoked("julia-fmt", "1.1.1")).not.toBeNull();
  });

  test("a refresh that outruns its budget does not block", async () => {
    invokeHandlers.set(
      "marketplace_fetch_revocations",
      () => new Promise((resolve) => setTimeout(() => resolve(feed([{}])), 5000)),
    );

    const started = Date.now();
    await pluginRevocations.refresh({ budgetMs: 30 });

    expect(Date.now() - started).toBeLessThan(1000);
    expect(pluginRevocations.isRevoked("julia-fmt", "1.1.1")).toBeNull();
  });
});
