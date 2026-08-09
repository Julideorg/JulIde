import { describe, expect, test } from "bun:test";
import {
  extractHandlerSlice,
  parseCommandList,
  scrapeCommands,
} from "./generate-permission-catalog";

const real = await Bun.file("src-tauri/src/lib.rs").text();

const wrap = (inner: string) =>
  `fn run() {\n  .invoke_handler(tauri::generate_handler![\n${inner}\n  ])\n}`;

describe("extractHandlerSlice", () => {
  test("finds the real handler list", () => {
    const slice = extractHandlerSlice(real);
    expect(slice).toContain("fs::fs_read_file");
    expect(slice).toContain("plugins::plugin_scan");
  });

  test("survives a reformat to one line", () => {
    expect(parseCommandList(extractHandlerSlice(wrap("a::x, b::y")))).toEqual(["x", "y"]);
  });

  test("a block comment containing a bracket does not truncate it", () => {
    // The exact case a regex-based extraction gets wrong — and gets wrong quietly,
    // producing a shorter list that still looks plausible.
    const slice = extractHandlerSlice(wrap("a::x,\n/* see foo[0] for why */\nb::y"));
    expect(parseCommandList(slice)).toEqual(["x", "y"]);
  });

  test("a line comment containing a bracket does not truncate it", () => {
    expect(parseCommandList(extractHandlerSlice(wrap("a::x,\n// closes ] here\nb::y")))).toEqual([
      "x",
      "y",
    ]);
  });

  test("a string literal containing brackets does not confuse it", () => {
    const slice = extractHandlerSlice(wrap('a::x,\n// note "] [" in text\nb::y'));
    expect(parseCommandList(slice)).toEqual(["x", "y"]);
  });

  test("nested brackets are matched, not counted once", () => {
    expect(parseCommandList(extractHandlerSlice(wrap("a::x,\n// [nested [deep]]\nb::y")))).toEqual([
      "x",
      "y",
    ]);
  });

  test("no handler at all is an error, not an empty list", () => {
    // An empty list would pass every downstream assertion and publish a catalog saying
    // julIDE has no commands.
    expect(() => extractHandlerSlice("fn run() {}")).toThrow(/found 0/);
  });

  test("two handlers are an error, because the script assumes one", () => {
    expect(() => extractHandlerSlice(`${wrap("a::x")}\n${wrap("b::y")}`)).toThrow(/found 2/);
  });

  test("an unterminated handler is an error", () => {
    expect(() => extractHandlerSlice("tauri::generate_handler![a::x,")).toThrow(/Unterminated/);
  });
});

describe("parseCommandList", () => {
  test("handles multi-segment paths and trailing commas", () => {
    expect(parseCommandList("crate::a::b,\n  mod::c,\n")).toEqual(["b", "c"]);
  });

  test("sorts and preserves every entry", () => {
    expect(parseCommandList("z::zeta, a::alpha")).toEqual(["alpha", "zeta"]);
  });

  test("an unparseable item throws rather than being dropped", () => {
    // Silently dropping one would understate the set of commands plugins may never
    // call, which is precisely the thing this artifact exists to state.
    expect(() => parseCommandList("a::x, #[cfg(unix)] b::y")).toThrow(/Could not parse/);
  });
});

describe("scrapeCommands", () => {
  test("the real handler list passes every assertion", () => {
    const commands = scrapeCommands(real);
    expect(commands.length).toBeGreaterThanOrEqual(100);
    expect(new Set(commands).size).toBe(commands.length);
  });

  test("a suspiciously short list is refused", () => {
    // The failure this whole scanner exists to make loud.
    expect(() => scrapeCommands(wrap("a::x, b::y"))).toThrow(/expected at least/);
  });

  test("every mapped command still exists in the handler list", () => {
    // Catches a renamed Rust command leaving a dangling TypeScript mapping, which is
    // otherwise invisible — the stale entry simply never matches anything.
    expect(() => scrapeCommands(real)).not.toThrow();
  });
});
