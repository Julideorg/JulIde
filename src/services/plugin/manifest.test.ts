import { describe, expect, test } from "bun:test";
import { SUPPORTED_API_VERSION, parseManifest } from "./manifest";

const base = {
  apiVersion: 2,
  name: "my-plugin",
  version: "1.0.0",
  displayName: "My Plugin",
  main: "dist/index.js",
};

function ok(raw: unknown) {
  const r = parseManifest(raw);
  if (!r.ok) throw new Error(`expected ok, got: ${r.errors.join("; ")}`);
  return r;
}

function fail(raw: unknown) {
  const r = parseManifest(raw);
  if (r.ok) throw new Error("expected failure");
  return r;
}

describe("apiVersion is the migration gate", () => {
  test("accepts the supported version", () => {
    expect(ok(base).manifest.apiVersion).toBe(SUPPORTED_API_VERSION);
  });

  test("a manifest with no apiVersion is treated as v1 and refused", () => {
    // Every plugin written before the sandbox omits the field. Defaulting to the
    // current version would load it into a world where `render(el)` silently does
    // nothing, which is a worse failure than refusing.
    const { apiVersion, ...noVersion } = base;
    void apiVersion;
    const r = fail(noVersion);
    expect(r.incompatible).toBe(true);
    expect(r.errors[0]).toContain("1.x");
  });

  test("incompatible is distinguished from malformed", () => {
    // Settings shows a migration link for one and a parse error for the other.
    expect(fail({ ...base, apiVersion: 1 }).incompatible).toBe(true);
    expect(fail({ ...base, name: "" }).incompatible).toBe(false);
    expect(fail("not an object").incompatible).toBe(false);
  });

  test("a future api version is refused too, not assumed compatible", () => {
    expect(fail({ ...base, apiVersion: 3 }).incompatible).toBe(true);
  });
});

describe("required fields", () => {
  test("name, version and main are required", () => {
    expect(fail({ ...base, name: undefined }).errors.join()).toContain("`name`");
    expect(fail({ ...base, version: undefined }).errors.join()).toContain("`version`");
    expect(fail({ ...base, main: undefined }).errors.join()).toContain("`main`");
  });

  test("displayName falls back to name", () => {
    const { displayName, ...noDisplay } = base;
    void displayName;
    expect(ok(noDisplay).manifest.displayName).toBe("my-plugin");
  });

  test("whitespace-only strings do not count as present", () => {
    expect(fail({ ...base, name: "   " }).ok).toBe(false);
  });
});

describe("network", () => {
  test("valid origins are carried through", () => {
    expect(ok({ ...base, network: ["https://api.github.com"] }).manifest.network.allowed).toEqual([
      "https://api.github.com",
    ]);
  });

  test("a rejected origin is a warning, not a parse failure", () => {
    // The plugin still loads; it just does not get that egress, and the consent
    // dialog says so. Refusing to load would let one typo brick a plugin.
    const r = ok({ ...base, network: ["https://*.evil.com"] });
    expect(r.manifest.network.allowed).toEqual([]);
    expect(r.warnings.join()).toContain("wildcard");
  });

  test("no network field means no egress", () => {
    expect(ok(base).manifest.network.allowed).toEqual([]);
  });
});

describe("declarative views", () => {
  const withViews = (views: unknown) => ({ ...base, contributes: { views } });

  test("parses a sidebar and a panel view", () => {
    const r = ok(
      withViews([
        { id: "explorer", kind: "sidebar", title: "My Explorer", icon: "Puzzle" },
        { id: "log", kind: "panel", title: "My Log", icon: "List" },
      ]),
    );
    expect(r.manifest.views).toHaveLength(2);
    expect(r.manifest.views[0]).toEqual({
      id: "explorer",
      kind: "sidebar",
      title: "My Explorer",
      icon: "Puzzle",
    });
  });

  test("no contributes means no views", () => {
    expect(ok(base).manifest.views).toEqual([]);
    expect(ok({ ...base, contributes: {} }).manifest.views).toEqual([]);
  });

  test("an unknown icon is refused", () => {
    // An arbitrary icon string reaching an <img src> is an exfiltration channel:
    // the request itself is the signal.
    const r = fail(withViews([{ id: "a", kind: "panel", title: "A", icon: "https://evil.com/x" }]));
    expect(r.errors.join()).toContain("built-in icons");
  });

  test("an unknown kind is refused", () => {
    expect(
      fail(withViews([{ id: "a", kind: "modal", title: "A", icon: "Puzzle" }])).errors.join(),
    ).toContain("sidebar");
  });

  test("view ids follow the same grammar as plugin names", () => {
    // The id becomes part of a DOM id and a frame URL.
    for (const id of ["../escape", "Has Spaces", "UPPER", "trailing-", "-leading", ""]) {
      expect(fail(withViews([{ id, kind: "panel", title: "A", icon: "Puzzle" }])).ok, id).toBe(
        false,
      );
    }
    expect(ok(withViews([{ id: "a", kind: "panel", title: "A", icon: "Puzzle" }])).ok).toBe(true);
  });

  test("duplicate view ids are refused", () => {
    // Otherwise one silently overwrites the other and a panel just goes missing.
    const r = fail(
      withViews([
        { id: "log", kind: "panel", title: "One", icon: "List" },
        { id: "log", kind: "sidebar", title: "Two", icon: "List" },
      ]),
    );
    expect(r.errors.join()).toContain("duplicate");
  });

  test("the view count is capped", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `v${i}`,
      kind: "panel",
      title: `V${i}`,
      icon: "List",
    }));
    expect(fail(withViews(many)).errors.join()).toContain("at most");
  });

  test("an overlong title is refused", () => {
    expect(
      fail(withViews([{ id: "a", kind: "panel", title: "x".repeat(200), icon: "List" }])).ok,
    ).toBe(false);
  });

  test("views must be an array", () => {
    expect(fail(withViews({ id: "a" })).errors.join()).toContain("must be an array");
  });
});

describe("permissions and activation events", () => {
  test("permissions pass through raw for the consent step to filter", () => {
    // parsePermissions drops unknown ones and unknownPermissions reports them; doing
    // it twice in two places would be two chances to disagree.
    expect(ok({ ...base, permissions: ["julia:run", "not-real"] }).manifest.permissions).toEqual([
      "julia:run",
      "not-real",
    ]);
  });

  test("non-string entries are dropped rather than crashing the parse", () => {
    expect(ok({ ...base, permissions: ["julia:run", 42, null] }).manifest.permissions).toEqual([
      "julia:run",
    ]);
  });

  test("a non-array permissions field yields none", () => {
    expect(ok({ ...base, permissions: "julia:run" }).manifest.permissions).toEqual([]);
  });
});
