import { describe, expect, test } from "bun:test";
import { buildLanguageIndex, fenceLanguage, sanitizeColorized } from "./highlight";

/**
 * The monaco-free half of the highlighter. `bun test` cannot load the editor, so what is
 * covered here is the fence-tag resolution — which is where the bugs would be anyway.
 */

// A cut-down stand-in for monaco.languages.getLanguages(), including the two collisions
// that make the precedence rules in buildLanguageIndex worth having: Julia is registered
// twice, and both C and C++ claim `.h`.
const LANGUAGES = [
  { id: "julia", aliases: ["Julia", "julia"], extensions: [".jl"] },
  { id: "julia" },
  { id: "python", aliases: ["Python", "py"], extensions: [".py"] },
  { id: "shell", aliases: ["Shell", "sh", "bash"], extensions: [".sh"] },
  { id: "typescript", aliases: ["TypeScript", "ts"], extensions: [".ts"] },
  { id: "c", extensions: [".c", ".h"] },
  { id: "cpp", aliases: ["C++"], extensions: [".cpp", ".h"] },
];

describe("buildLanguageIndex", () => {
  const index = buildLanguageIndex(LANGUAGES);

  test("resolves ids, aliases and extensions alike", () => {
    expect(index.get("julia")).toBe("julia");
    expect(index.get("jl")).toBe("julia");
    expect(index.get("py")).toBe("python");
    expect(index.get("bash")).toBe("shell");
    expect(index.get("ts")).toBe("typescript");
    expect(index.get("c++")).toBe("cpp");
  });

  test("an unknown tag resolves to nothing, so the block stays plain", () => {
    expect(index.get("brainfuck")).toBeUndefined();
  });

  test("a real language id outranks another language's extension", () => {
    // Both c and cpp claim `.h`; neither may displace the `c` id itself.
    expect(index.get("c")).toBe("c");
  });
});

describe("fenceLanguage", () => {
  test("reads the class marked emits", () => {
    expect(fenceLanguage("language-julia")).toBe("julia");
    expect(fenceLanguage("language-C++")).toBe("c++");
  });

  test("finds it alongside the classes this hook adds", () => {
    expect(fenceLanguage("language-python md-hl--done")).toBe("python");
  });

  test("returns null for an unfenced code element", () => {
    expect(fenceLanguage("")).toBeNull();
    expect(fenceLanguage("md-hl--done")).toBeNull();
  });

  test("does not match a class that merely ends in language-", () => {
    expect(fenceLanguage("my-language-julia")).toBeNull();
  });
});

describe("sanitizeColorized", () => {
  test("fails closed when no DOM is present, rather than passing markup through", () => {
    // This is the state under `bun test`. Returning the input would put unsanitized
    // markup on a path to innerHTML the moment someone ran these in a DOM shim.
    expect(sanitizeColorized("<span class='mtk1'>x</span>")).toBeNull();
  });
});
