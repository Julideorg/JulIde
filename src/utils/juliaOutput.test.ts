import { describe, expect, it } from "bun:test";
import { MIME_MARKER, parseMimeLine, stripAnsiForDisplay } from "./juliaOutput";

describe("parseMimeLine", () => {
  it("parses a valid marker line", () => {
    const line = `${MIME_MARKER}{"type":"image/png","data":"e30="}%%`;
    expect(parseMimeLine(line)).toEqual({
      type: "image/png",
      data: "e30=",
    });
  });

  it("accepts trailing CR (defensive for any non-Rust path)", () => {
    const line = `${MIME_MARKER}{"type":"image/png","data":"e30="}%%\r`;
    expect(parseMimeLine(line)).toEqual({
      type: "image/png",
      data: "e30=",
    });
  });
});

describe("stripAnsiForDisplay", () => {
  it("removes SGR and common CSI used in Julia print styling", () => {
    const raw = "\u001b[7mjulide\u001b[0m";
    expect(stripAnsiForDisplay(raw)).toBe("julide");
  });
});
