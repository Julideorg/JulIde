import { describe, expect, test } from "bun:test";
import { classifyMarkdownHref } from "./links";

const WS = "/home/dev/MyPkg";
const DOC = "/home/dev/MyPkg/README.md";

describe("classifyMarkdownHref", () => {
  test("http and https are external", () => {
    expect(classifyMarkdownHref("https://julialang.org", DOC, WS)).toEqual({
      kind: "external",
      url: "https://julialang.org/",
    });
    expect(classifyMarkdownHref("http://example.com/a?b=1", DOC, WS).kind).toBe("external");
  });

  test("a bare fragment is an in-page anchor", () => {
    expect(classifyMarkdownHref("#installation", DOC, WS)).toEqual({
      kind: "anchor",
      id: "installation",
    });
  });

  test("relative paths resolve against the document's directory", () => {
    expect(classifyMarkdownHref("./docs/guide.md", DOC, WS)).toEqual({
      kind: "file",
      path: "/home/dev/MyPkg/docs/guide.md",
    });
    expect(classifyMarkdownHref("docs/guide.md", DOC, WS)).toEqual({
      kind: "file",
      path: "/home/dev/MyPkg/docs/guide.md",
    });
  });

  test("`..` is allowed while it stays inside the workspace", () => {
    const nested = "/home/dev/MyPkg/docs/api.md";
    expect(classifyMarkdownHref("../README.md", nested, WS)).toEqual({
      kind: "file",
      path: "/home/dev/MyPkg/README.md",
    });
  });

  test("a path that climbs out of the workspace is blocked", () => {
    // The backend's fs_read_file has no path restriction of its own, so this check is
    // the only thing between a cloned README and an arbitrary file opening in a tab.
    const link = classifyMarkdownHref("../../../../etc/passwd", DOC, WS);
    expect(link.kind).toBe("blocked");
    expect(link).toHaveProperty("reason");
  });

  test("an absolute path outside the workspace is blocked too", () => {
    expect(classifyMarkdownHref("/etc/shadow", DOC, WS).kind).toBe("blocked");
  });

  test("an absolute path inside the workspace is allowed", () => {
    expect(classifyMarkdownHref("/home/dev/MyPkg/src/main.jl", DOC, WS)).toEqual({
      kind: "file",
      path: "/home/dev/MyPkg/src/main.jl",
    });
  });

  test("the workspace root itself is inside the workspace", () => {
    expect(classifyMarkdownHref("/home/dev/MyPkg", DOC, WS).kind).toBe("file");
  });

  test("a sibling directory sharing a name prefix does not count as inside", () => {
    // /home/dev/MyPkgSecrets must not pass a naive startsWith check against /home/dev/MyPkg.
    expect(classifyMarkdownHref("/home/dev/MyPkgSecrets/a.md", DOC, WS).kind).toBe("blocked");
  });

  test("active schemes are inert", () => {
    for (const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "mailto:someone@example.com",
    ]) {
      expect(classifyMarkdownHref(href, DOC, WS).kind).toBe("unsupported");
    }
  });

  test("empty, whitespace and missing hrefs are inert", () => {
    expect(classifyMarkdownHref("", DOC, WS).kind).toBe("unsupported");
    expect(classifyMarkdownHref("   ", DOC, WS).kind).toBe("unsupported");
    expect(classifyMarkdownHref(null, DOC, WS).kind).toBe("unsupported");
    expect(classifyMarkdownHref(undefined, DOC, WS).kind).toBe("unsupported");
  });

  test("a file link keeps its fragment so the target can be scrolled", () => {
    expect(classifyMarkdownHref("./guide.md#usage", DOC, WS)).toEqual({
      kind: "file",
      path: "/home/dev/MyPkg/guide.md",
      anchor: "usage",
    });
  });

  test("a query string is dropped rather than treated as part of the name", () => {
    expect(classifyMarkdownHref("./guide.md?raw=1", DOC, WS)).toEqual({
      kind: "file",
      path: "/home/dev/MyPkg/guide.md",
    });
  });

  test("percent-encoded paths are decoded", () => {
    expect(classifyMarkdownHref("./my%20guide.md", DOC, WS)).toEqual({
      kind: "file",
      path: "/home/dev/MyPkg/my guide.md",
    });
  });

  test("a malformed escape is passed through rather than throwing", () => {
    expect(classifyMarkdownHref("./100%.md", DOC, WS)).toEqual({
      kind: "file",
      path: "/home/dev/MyPkg/100%.md",
    });
  });

  test("backslash separators are normalised", () => {
    expect(classifyMarkdownHref(".\\docs\\guide.md", DOC, WS)).toEqual({
      kind: "file",
      path: "/home/dev/MyPkg/docs/guide.md",
    });
  });

  test("with no workspace open there is nothing to escape, so paths are allowed", () => {
    expect(classifyMarkdownHref("../../elsewhere.md", DOC, null)).toEqual({
      kind: "file",
      path: "/home/elsewhere.md",
    });
  });

  test("a trailing slash on the workspace path does not change the verdict", () => {
    expect(classifyMarkdownHref("./docs/guide.md", DOC, `${WS}/`).kind).toBe("file");
    expect(classifyMarkdownHref("/etc/passwd", DOC, `${WS}/`).kind).toBe("blocked");
  });
});
