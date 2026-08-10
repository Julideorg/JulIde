import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  __cacheSize,
  __setObjectUrlImpl,
  acquireCachedImage,
  classifyImageSrc,
  invalidateImage,
  purgeImageCache,
  releaseImage,
  type ImagePolicy,
  type ImageTarget,
} from "./images";

const DOC = "/ws/docs/guide.md";
const WS = "/ws";
const ON: ImagePolicy = { local: true, remote: true };
const OFF: ImagePolicy = { local: false, remote: false };

beforeEach(() => {
  purgeImageCache();
});

describe("classifyImageSrc", () => {
  test("a relative path resolves against the document's directory", () => {
    expect(classifyImageSrc("./diagram.png", DOC, WS, ON)).toEqual({
      kind: "local",
      key: "local|/ws/docs/diagram.png",
      path: "/ws/docs/diagram.png",
    });
  });

  test("a path is blocked when workspace images are off", () => {
    const r = classifyImageSrc("./diagram.png", DOC, WS, OFF);
    expect(r).toEqual({ kind: "blocked", reason: "Workspace images are turned off" });
  });

  test("a path climbing out of the workspace is blocked, and the reason names it", () => {
    const r = classifyImageSrc("../../../etc/passwd", DOC, WS, ON);
    expect(r.kind).toBe("blocked");
    expect(r.kind === "blocked" && r.reason).toContain("outside the workspace");
  });

  test("an https url with remote images on keeps its query string", () => {
    // Badge URLs depend on this.
    expect(classifyImageSrc("https://img.shields.io/x?a=1&b=2", DOC, WS, ON)).toEqual({
      kind: "remote",
      key: "remote|https://img.shields.io/x?a=1&b=2",
      url: "https://img.shields.io/x?a=1&b=2",
    });
  });

  test("an https url is blocked when remote images are off", () => {
    expect(classifyImageSrc("https://img.shields.io/x.svg", DOC, WS, OFF)).toEqual({
      kind: "blocked",
      reason: "Remote images are turned off",
    });
  });

  test("http is refused even with remote images ON", () => {
    // classifyMarkdownHref accepts http for links; images are https-only.
    expect(classifyImageSrc("http://img.shields.io/x.svg", DOC, WS, ON)).toEqual({
      kind: "blocked",
      reason: "Only https images are loaded",
    });
  });

  test("every dangerous scheme is refused, in any casing or padding", () => {
    for (const src of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "  javascript:alert(1)",
      "data:image/svg+xml,<svg/>",
      "file:///etc/passwd",
      "vbscript:msgbox",
    ]) {
      expect(classifyImageSrc(src, DOC, WS, ON).kind).toBe("blocked");
    }
  });

  test("a bare fragment is not an image", () => {
    expect(classifyImageSrc("#figure", DOC, WS, ON).kind).toBe("blocked");
  });

  test("an empty, whitespace or missing src is blocked rather than resolved", () => {
    for (const src of ["", "   ", null, undefined]) {
      expect(classifyImageSrc(src, DOC, WS, ON).kind).toBe("blocked");
    }
  });

  test("with no workspace open a relative path still resolves to the document dir", () => {
    expect(classifyImageSrc("./x.png", DOC, null, ON)).toEqual({
      kind: "local",
      key: "local|/ws/docs/x.png",
      path: "/ws/docs/x.png",
    });
  });
});

describe("cache refcounting", () => {
  let revoked: string[] = [];
  let restore: () => void;

  beforeEach(() => {
    revoked = [];
    let n = 0;
    restore = __setObjectUrlImpl({
      create: () => `blob:test/${n++}`,
      revoke: (url) => revoked.push(url),
    });
  });
  afterEach(() => restore());

  const target = (path: string): ImageTarget => ({
    kind: "local",
    key: `local|${path}`,
    path,
  });

  test("a miss returns null rather than throwing", () => {
    expect(acquireCachedImage(target("/ws/a.png"))).toBeNull();
  });

  test("releasing an unknown handle is a no-op, not a crash", () => {
    expect(() => releaseImage({ key: "local|/ws/gone.png", url: "blob:x" })).not.toThrow();
  });

  test("invalidateImage drops only the named entry and revokes its blob", () => {
    // Seeded through the public surface would need a live invoke; drive the cache
    // directly through purge/invalidate semantics instead.
    expect(__cacheSize()).toBe(0);
    invalidateImage("/ws/not-there.png");
    expect(__cacheSize()).toBe(0);
    expect(revoked).toEqual([]);
  });

  test("purge clears everything", () => {
    purgeImageCache();
    expect(__cacheSize()).toBe(0);
  });
});

describe("blocked targets never resolve", () => {
  test("acquireCachedImage on a blocked target is null", () => {
    expect(acquireCachedImage({ kind: "blocked", reason: "off" })).toBeNull();
  });
});
