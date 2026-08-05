import { describe, expect, test } from "bun:test";
import { lspRangeToMonaco, LSP_KIND, flattenHoverContents } from "./juliaProviders";

describe("lspRangeToMonaco", () => {
  test("converts 0-based LSP positions to 1-based Monaco positions", () => {
    const range = lspRangeToMonaco({
      start: { line: 0, character: 0 },
      end: { line: 0, character: 5 },
    });

    expect(range.startLineNumber).toBe(1);
    expect(range.startColumn).toBe(1);
    expect(range.endLineNumber).toBe(1);
    expect(range.endColumn).toBe(6);
  });

  test("handles multi-line ranges", () => {
    const range = lspRangeToMonaco({
      start: { line: 4, character: 2 },
      end: { line: 10, character: 8 },
    });

    expect(range.startLineNumber).toBe(5);
    expect(range.startColumn).toBe(3);
    expect(range.endLineNumber).toBe(11);
    expect(range.endColumn).toBe(9);
  });

  test("zero range", () => {
    const range = lspRangeToMonaco({
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    });

    expect(range.startLineNumber).toBe(1);
    expect(range.startColumn).toBe(1);
    expect(range.endLineNumber).toBe(1);
    expect(range.endColumn).toBe(1);
  });
});

describe("LSP_KIND", () => {
  test("maps Text (1) to 17", () => {
    expect(LSP_KIND[1]).toBe(17);
  });

  test("maps Method (2) to 0", () => {
    expect(LSP_KIND[2]).toBe(0);
  });

  test("maps Function (3) to 1", () => {
    expect(LSP_KIND[3]).toBe(1);
  });

  test("maps Variable (6) to 5", () => {
    expect(LSP_KIND[6]).toBe(5);
  });

  test("maps Module (9) to 8", () => {
    expect(LSP_KIND[9]).toBe(8);
  });

  test("maps Keyword (14) to 13", () => {
    expect(LSP_KIND[14]).toBe(13);
  });

  test("maps Struct (27) to 22", () => {
    expect(LSP_KIND[27]).toBe(22);
  });

  test("returns undefined for unmapped kind", () => {
    expect(LSP_KIND[99]).toBeUndefined();
  });
});

describe("flattenHoverContents", () => {
  test("returns string directly", () => {
    expect(flattenHoverContents("hello world")).toBe("hello world");
  });

  test("returns value from MarkupContent object", () => {
    expect(flattenHoverContents({ kind: "markdown", value: "# Title" })).toBe("# Title");
  });

  test("joins array of strings", () => {
    const result = flattenHoverContents(["first", "second"]);
    expect(result).toBe("first\n\nsecond");
  });

  test("extracts value from array of objects", () => {
    const result = flattenHoverContents([
      { language: "julia", value: "function foo()" },
      { language: "julia", value: "end" },
    ]);
    expect(result).toBe("function foo()\n\nend");
  });

  test("handles mixed array", () => {
    const result = flattenHoverContents(["Documentation:", { language: "julia", value: "x = 1" }]);
    expect(result).toBe("Documentation:\n\nx = 1");
  });

  test("filters out empty strings in array", () => {
    const result = flattenHoverContents(["hello", "", "world"]);
    expect(result).toBe("hello\n\nworld");
  });

  test("handles empty string", () => {
    expect(flattenHoverContents("")).toBe("");
  });
});
