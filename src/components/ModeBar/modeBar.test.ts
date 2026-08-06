import { describe, expect, test } from "bun:test";
import { flattenTree, fuzzyMatch, rank } from "./fuzzy";
import { MODES, parseInput } from "./modes";
import type { FileNode } from "../../types";

describe("fuzzyMatch", () => {
  test("requires the query to be a subsequence", () => {
    expect(fuzzyMatch("abc", "axbxc")).toBeGreaterThan(0);
    expect(fuzzyMatch("acb", "axbxc")).toBe(-1);
  });

  test("is case-insensitive", () => {
    expect(fuzzyMatch("SOLVER", "solver.jl")).toBeGreaterThan(0);
  });

  test("ranks word-boundary matches above incidental ones", () => {
    // "gr" starting two path segments should beat the same letters buried mid-word.
    const boundary = fuzzyMatch("gr", "git/repo.jl");
    const buried = fuzzyMatch("gr", "aggregate.jl");
    expect(boundary).toBeGreaterThan(buried);
  });

  test("ranks consecutive matches above scattered ones", () => {
    expect(fuzzyMatch("solve", "solver.jl")).toBeGreaterThan(fuzzyMatch("solve", "s_o_l_v_e.jl"));
  });
});

describe("rank", () => {
  const items = ["alpha.jl", "beta.jl", "alphabet.jl"];

  test("an empty query preserves the original order", () => {
    expect(rank("", items, (s) => s)).toEqual(items);
  });

  test("drops non-matches and orders best first", () => {
    const result = rank("alpha", items, (s) => s);
    expect(result).not.toContain("beta.jl");
    expect(result[0]).toBe("alpha.jl");
  });

  test("honours the limit", () => {
    expect(rank("", items, (s) => s, 2)).toHaveLength(2);
  });
});

describe("flattenTree", () => {
  const tree: FileNode = {
    name: "project",
    path: "/w/project",
    is_dir: true,
    children: [
      { name: "solver.jl", path: "/w/project/solver.jl", is_dir: false },
      {
        name: "src",
        path: "/w/project/src",
        is_dir: true,
        children: [{ name: "utils.jl", path: "/w/project/src/utils.jl", is_dir: false }],
      },
    ],
  };

  test("lists files only, with paths relative to the root", () => {
    expect(flattenTree(tree)).toEqual([
      { name: "solver.jl", path: "/w/project/solver.jl", relativePath: "project/solver.jl" },
      {
        name: "utils.jl",
        path: "/w/project/src/utils.jl",
        relativePath: "project/src/utils.jl",
      },
    ]);
  });

  test("an empty directory yields nothing", () => {
    expect(flattenTree({ name: "empty", path: "/w/empty", is_dir: true })).toEqual([]);
  });
});

describe("parseInput", () => {
  test("bare text is the default file-finding mode", () => {
    const { mode, query } = parseInput("solver");
    expect(mode.id).toBe("files");
    expect(query).toBe("solver");
  });

  // The grammar is Julia's REPL grammar; these prefixes are the whole premise.
  test.each([
    ["]", "packages"],
    ["?", "lookup"],
    [";", "shell"],
    [">", "commands"],
    ["@", "symbols"],
    ["#", "problems"],
  ])("%s switches to the %s mode", (prefix, expected) => {
    const { mode, query } = parseInput(`${prefix}Plots`);
    expect(mode.id).toBe(expected);
    expect(query).toBe("Plots");
  });

  test("the prefix alone selects the mode with an empty query", () => {
    const { mode, query } = parseInput("]");
    expect(mode.id).toBe("packages");
    expect(query).toBe("");
  });

  test("empty input is the default mode", () => {
    expect(parseInput("").mode.id).toBe("files");
  });

  test("every prefix is distinct and single-character", () => {
    const prefixes = MODES.map((m) => m.prefix).filter(Boolean);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    expect(prefixes.every((p) => p.length === 1)).toBe(true);
  });

  test("exactly one mode is the prefix-less default", () => {
    expect(MODES.filter((m) => m.prefix === "")).toHaveLength(1);
    expect(MODES[0].prefix).toBe("");
  });
});
