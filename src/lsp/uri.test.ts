import { describe, expect, test } from "bun:test";
import { basename, pathToUri, uriToPath } from "./uri";
// Reached by path rather than by package name: monaco-editor's exports map does
// not publish this subpath, and the point of the test below is to check against
// the real encoder rather than a copy of what it was believed to do.
import { URI } from "../../node_modules/monaco-editor/esm/vs/base/common/uri.js";

/** Paths worth converting, across all three platforms' shapes. */
const PATHS = [
  "/home/me/proj",
  "/home/me/proj/src/a.jl",
  "/home/me/My Proj/a.jl",
  "/home/joão/a.jl",
  "/tmp/c#/100%/a.jl",
  "/tmp/a,b;c=d!e/f(g).jl",
  "C:\\Users\\joaquim\\proj",
  "C:\\Users\\joaquim\\My Proj\\a.jl",
  "\\\\srv\\share\\proj",
];

describe("pathToUri", () => {
  test("builds a valid URI from a Windows drive path", () => {
    // The regression from issue #38: `file://` + `C:\Users\joaquim` put the
    // drive where the authority goes and left a backslash at index 9, which is
    // the exact position the URI parser reported before Fatou gave up.
    expect(pathToUri("C:\\Users\\joaquim\\proj")).toBe("file:///c%3A/Users/joaquim/proj");
  });

  test("lower-cases the drive letter, as Monaco does when it parses one back", () => {
    expect(pathToUri("D:/Code/a.jl")).toBe("file:///d%3A/Code/a.jl");
  });

  test("maps a UNC host onto the URI authority", () => {
    expect(pathToUri("\\\\srv\\share\\proj")).toBe("file://srv/share/proj");
  });

  test("keeps a POSIX path as the URI path", () => {
    expect(pathToUri("/home/me/proj")).toBe("file:///home/me/proj");
  });

  test("percent-encodes what a URI cannot carry literally", () => {
    // Broken on every platform before this, not just Windows: a space is not a
    // legal URI character, so the handshake failed the same way for anyone
    // whose project lived under a directory with a space in the name.
    expect(pathToUri("/home/me/My Proj")).toBe("file:///home/me/My%20Proj");
    expect(pathToUri("/home/joão/a.jl")).toBe("file:///home/jo%C3%A3o/a.jl");
    expect(pathToUri("/tmp/c#/100%/a.jl")).toBe("file:///tmp/c%23/100%25/a.jl");
  });

  test("encodes sub-delimiters, which a URI could carry but Monaco does not", () => {
    // `,;=!()` are all legal in a path segment, and encodeURIComponent leaves
    // `!()` alone — but Monaco encodes every one of them, and agreeing with
    // Monaco is what the invariant below is about.
    expect(pathToUri("/tmp/a,b;c=d!e/f(g)")).toBe("file:///tmp/a%2Cb%3Bc%3Dd%21e/f%28g%29");
  });

  test("is idempotent, so applying it to a URI is harmless", () => {
    for (const path of PATHS) {
      const uri = pathToUri(path);
      expect(pathToUri(uri)).toBe(uri);
    }
  });
});

describe("agreement with Monaco", () => {
  test("produces exactly what Monaco produces for the same document", () => {
    // The editor's model is created from this string, and the LSP providers read
    // the document's URI back off that model. If Monaco re-encodes the string
    // into a different one, the editor asks the server about a document the
    // server was never told was open — and nothing says so, the replies are just
    // empty. Pinned against the real encoder so a Monaco upgrade cannot move it
    // quietly.
    for (const path of PATHS) {
      const uri = pathToUri(path);
      expect(URI.parse(uri).toString()).toBe(uri);
    }
  });
});

describe("uriToPath", () => {
  test("round-trips every shape of path", () => {
    for (const path of PATHS) {
      // Windows shapes come back with backslashes on every platform, since the
      // separator is a property of the path, not of the machine reading it.
      expect(uriToPath(pathToUri(path))).toBe(path);
    }
  });

  test("restores a Windows path with its native separator", () => {
    expect(uriToPath("file:///c%3A/Users/joaquim/proj")).toBe("C:\\Users\\joaquim\\proj");
    expect(uriToPath("file://srv/share/proj")).toBe("\\\\srv\\share\\proj");
  });

  test("accepts an unencoded drive colon", () => {
    // We send the encoded form, but a server is free to normalize it back — both
    // spellings are the same valid URI.
    expect(uriToPath("file:///c:/Users/me")).toBe("C:\\Users\\me");
  });

  test("leaves a non-file URI alone", () => {
    expect(uriToPath("untitled:Untitled-1")).toBe("untitled:Untitled-1");
  });

  test("does not throw on a malformed escape", () => {
    // This runs inside the publishDiagnostics handler, where an exception would
    // take down the subscription and stop every later diagnostic with it.
    expect(uriToPath("file:///home/me/100%/a.jl")).toBe("/home/me/100%/a.jl");
  });
});

describe("basename", () => {
  test("splits on either separator", () => {
    expect(basename("/home/me/proj")).toBe("proj");
    expect(basename("C:\\Users\\me\\proj")).toBe("proj");
  });

  test("ignores a trailing separator", () => {
    expect(basename("/home/me/proj/")).toBe("proj");
    expect(basename("C:\\Users\\me\\proj\\")).toBe("proj");
  });
});
