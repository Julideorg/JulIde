import { describe, expect, test } from "bun:test";
import { formatSize, permissionsAdded, searchIndex } from "./marketplace";
import type { RegistryEntry } from "../types/marketplace";

const entry = (over: Partial<RegistryEntry>): RegistryEntry => ({
  name: "julia-fmt",
  displayName: "Julia Formatter",
  description: "Formats Julia source.",
  author: "Ada",
  repository: "https://github.com/a/julia-fmt",
  license: "MIT",
  categories: ["Formatters"],
  keywords: ["formatter"],
  latest: null,
  capability: { headline: "", capabilities: [], additionalCount: 0, tier: "low" },
  ...over,
});

const names = (results: RegistryEntry[]) => results.map((r) => r.name);

describe("searchIndex", () => {
  const index = [
    entry({ name: "julia-fmt", displayName: "Julia Formatter" }),
    entry({ name: "julia-lint", displayName: "Julia Linter", keywords: ["lint"] }),
    entry({
      name: "plot-tools",
      displayName: "Plot Tools",
      description: "Charts, including a julia-fmt integration.",
      keywords: [],
    }),
  ];

  test("an empty query returns everything, unreordered", () => {
    expect(names(searchIndex(index, ""))).toEqual(["julia-fmt", "julia-lint", "plot-tools"]);
    expect(names(searchIndex(index, "   "))).toHaveLength(3);
  });

  test("an exact name comes first", () => {
    // Someone typing a plugin's exact name wants it first, not behind everything whose
    // description happens to mention it.
    expect(names(searchIndex(index, "julia-fmt"))[0]).toBe("julia-fmt");
  });

  test("a prefix beats a description mention", () => {
    const results = names(searchIndex(index, "julia"));
    expect(results.slice(0, 2).sort()).toEqual(["julia-fmt", "julia-lint"]);
  });

  test("matches keywords and categories", () => {
    expect(names(searchIndex(index, "lint"))).toContain("julia-lint");
    expect(names(searchIndex(index, "formatters"))).toContain("julia-fmt");
  });

  test("is case-insensitive", () => {
    expect(names(searchIndex(index, "JULIA-FMT"))[0]).toBe("julia-fmt");
  });

  test("no match yields nothing rather than everything", () => {
    expect(searchIndex(index, "zzzz-nonexistent")).toEqual([]);
  });

  test("ties break by name, so the order is stable", () => {
    const a = entry({ name: "aaa-plugin", displayName: "A", description: "shared", keywords: [] });
    const z = entry({ name: "zzz-plugin", displayName: "Z", description: "shared", keywords: [] });
    expect(names(searchIndex([z, a], "shared"))).toEqual(["aaa-plugin", "zzz-plugin"]);
  });
});

describe("permissionsAdded", () => {
  test("reports only what is new", () => {
    expect(permissionsAdded(["workspace:read"], ["workspace:read", "julia:run"])).toEqual([
      "julia:run",
    ]);
  });

  test("a removed permission is not an addition", () => {
    expect(permissionsAdded(["workspace:read", "julia:run"], ["workspace:read"])).toEqual([]);
  });

  test("nothing added when the sets match", () => {
    expect(permissionsAdded(["a", "b"], ["b", "a"])).toEqual([]);
  });
});

describe("formatSize", () => {
  test("scales to the unit that reads", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(20114)).toBe("20 KB");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
