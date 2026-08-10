import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  __liveUrlCount,
  __setObjectUrlImpl,
  bundleToOutput,
  releaseAllOutputs,
  releaseOutputs,
} from "./notebookBlobs";

/**
 * The object-URL lifecycle, which is where a leak would hide: PlotPane only ever holds
 * one URL, but a notebook holds one per image output across every cell.
 */

let revoked: string[] = [];
let restore: () => void;

beforeEach(() => {
  releaseAllOutputs();
  revoked = [];
  let n = 0;
  restore = __setObjectUrlImpl({
    create: () => `blob:test/${n++}`,
    revoke: (url) => revoked.push(url),
  });
});

afterEach(() => {
  releaseAllOutputs();
  restore();
});

// 1x1 transparent PNG.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("bundleToOutput", () => {
  test("an image bundle becomes a URL, and the bytes do not reach the store", () => {
    const output = bundleToOutput("o1", "result", {
      "image/png": PNG,
      "text/plain": "Plot{...}",
    });
    expect(output.imageUrl).toBe("blob:test/0");
    expect(output.text).toBe("Plot{...}");
    // The base64 must not be anywhere on the object a selector would diff.
    expect(JSON.stringify(output)).not.toContain(PNG);
  });

  test("png wins over html when a bundle carries both", () => {
    const output = bundleToOutput("o1", "result", {
      "image/png": PNG,
      "text/html": "<b>x</b>",
      "text/plain": "x",
    });
    expect(output.imageUrl).toBeDefined();
    expect(output.html).toBeUndefined();
  });

  test("an html bundle is sanitized rather than passed through", () => {
    // Under bun test there is no DOM, so sanitizeMarkdown escapes instead — the point
    // is that the raw markup never survives verbatim.
    const output = bundleToOutput("o1", "result", { "text/html": "<script>alert(1)</script>" });
    expect(output.html).toBeDefined();
    expect(output.html).not.toContain("<script>");
  });

  test("a text-only bundle carries no URL", () => {
    const output = bundleToOutput("o1", "result", { "text/plain": "42" });
    expect(output.imageUrl).toBeUndefined();
    expect(output.text).toBe("42");
    expect(__liveUrlCount()).toBe(0);
  });

  test("the execution count is carried through for a result", () => {
    expect(bundleToOutput("o1", "result", { "text/plain": "1" }, 5).executionCount).toBe(5);
  });
});

describe("release", () => {
  test("releasing an output revokes exactly its URL", () => {
    const a = bundleToOutput("a", "result", { "image/png": PNG });
    const b = bundleToOutput("b", "result", { "image/png": PNG });
    expect(__liveUrlCount()).toBe(2);

    releaseOutputs([a]);
    expect(revoked).toEqual([a.imageUrl!]);
    expect(__liveUrlCount()).toBe(1);
    expect(b.imageUrl).toBeDefined();
  });

  test("releasing twice does not revoke twice", () => {
    const a = bundleToOutput("a", "result", { "image/png": PNG });
    releaseOutputs([a]);
    releaseOutputs([a]);
    expect(revoked).toHaveLength(1);
  });

  test("releasing a text output is a no-op", () => {
    const a = bundleToOutput("a", "result", { "text/plain": "42" });
    releaseOutputs([a]);
    expect(revoked).toEqual([]);
  });

  test("releaseAllOutputs empties the registry", () => {
    bundleToOutput("a", "result", { "image/png": PNG });
    bundleToOutput("b", "display", { "image/png": PNG });
    releaseAllOutputs();
    expect(revoked).toHaveLength(2);
    expect(__liveUrlCount()).toBe(0);
  });
});
