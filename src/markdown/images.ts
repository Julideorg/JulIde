import { invoke } from "@tauri-apps/api/core";
import { classifyMarkdownHref } from "./links";
import { sanitizeSvgDocument } from "./sanitize";

/**
 * Turning a markdown image reference into something an `<img>` can point at.
 *
 * Nothing here fetches in the webview. `image_load` reads the bytes in Rust — off disk
 * under the workspace root, or over an https-only hardened client — and returns base64,
 * which becomes a `blob:` (raster) or `data:` (SVG) URL. The CSP already permits both,
 * so no part of this feature widens it.
 *
 * **This module is not a boundary.** It re-checks the settings and refuses obviously
 * bad hrefs so the preview can explain itself without a round trip, but Rust checks the
 * same setting and re-resolves the same path before reading anything. Same split as
 * `sanitize_network` in plugin_protocol.rs:154.
 *
 * ## Cancellation leaks if you are not careful
 *
 * `invoke` is not abortable, so an aborted resolve still completes and still populates
 * the cache. Entries therefore land with `refs: 0` and the *caller* is responsible for
 * releasing a handle it no longer wants. An `acquireImage` that threw away its result on
 * abort would leak the object URL for the lifetime of the app.
 */

export interface ImagePolicy {
  local: boolean;
  remote: boolean;
}

export type ImageTarget =
  | { kind: "local"; key: string; path: string }
  | { kind: "remote"; key: string; url: string }
  | { kind: "blocked"; reason: string };

export interface ImageHandle {
  key: string;
  url: string;
}

interface CacheEntry {
  url: string;
  refs: number;
}

/** Bounded so a long session browsing docs does not accumulate object URLs forever. */
const MAX_CACHE_ENTRIES = 128;

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ImageHandle>>();

/**
 * Object-URL creation, injectable.
 *
 * `URL.createObjectURL` does not exist under `bun test`, and the refcount and eviction
 * logic is exactly where a leak would hide — so it has to be reachable by a test.
 */
let objectUrls = {
  create: (blob: Blob): string => URL.createObjectURL(blob),
  revoke: (url: string): void => URL.revokeObjectURL(url),
};

/** Test seam. Returns a function restoring the previous implementation. */
export function __setObjectUrlImpl(impl: typeof objectUrls): () => void {
  const previous = objectUrls;
  objectUrls = impl;
  return () => {
    objectUrls = previous;
  };
}

/**
 * What an image's src means, and whether the user has opted into loading it.
 *
 * Pure and DOM-free, which is where the interesting cases live.
 */
export function classifyImageSrc(
  src: string | null | undefined,
  docPath: string,
  workspacePath: string | null,
  policy: ImagePolicy,
): ImageTarget {
  const raw = src?.trim();
  if (!raw) return { kind: "blocked", reason: "This image has no source" };

  const link = classifyMarkdownHref(raw, docPath, workspacePath);

  switch (link.kind) {
    case "external": {
      // classifyMarkdownHref accepts http: as well (links.ts:23). Images do not:
      // a plaintext fetch is trivially observable and trivially tampered with.
      if (!link.url.startsWith("https://")) {
        return { kind: "blocked", reason: "Only https images are loaded" };
      }
      if (!policy.remote) {
        return { kind: "blocked", reason: "Remote images are turned off" };
      }
      return { kind: "remote", key: `remote|${link.url}`, url: link.url };
    }
    case "file": {
      if (!policy.local) {
        return { kind: "blocked", reason: "Workspace images are turned off" };
      }
      return { kind: "local", key: `local|${link.path}`, path: link.path };
    }
    case "blocked":
      return { kind: "blocked", reason: link.reason };
    case "anchor":
      // `![x](#y)` is meaningless as an image.
      return { kind: "blocked", reason: "Unsupported image source" };
    default:
      return { kind: "blocked", reason: "Unsupported image source" };
  }
}

function retain(key: string): ImageHandle | null {
  const entry = cache.get(key);
  if (!entry) return null;
  entry.refs += 1;
  // Re-insert so Map iteration order stays least-recently-used first.
  cache.delete(key);
  cache.set(key, entry);
  return { key, url: entry.url };
}

/** A synchronous cache hit, or null. Used first so a re-render never flashes. */
export function acquireCachedImage(target: ImageTarget): ImageHandle | null {
  if (target.kind === "blocked") return null;
  return retain(target.key);
}

export function releaseImage(handle: ImageHandle): void {
  const entry = cache.get(handle.key);
  if (!entry) return;
  // Clamped rather than allowed to go negative: a double release must not make the
  // entry look evictable while an <img> still points at it.
  entry.refs = Math.max(0, entry.refs - 1);
}

function evictIfNeeded(): void {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  for (const [key, entry] of cache) {
    if (cache.size <= MAX_CACHE_ENTRIES) break;
    // Skip anything a live <img> still points at — revoking that URL is how you get an
    // image that vanishes on the next reflow.
    if (entry.refs > 0) continue;
    release(entry.url);
    cache.delete(key);
  }
}

function release(url: string): void {
  // Only blobs need revoking; an SVG data: URL is inert and self-contained.
  if (url.startsWith("blob:")) objectUrls.revoke(url);
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function materialise(mime: string, base64: string): string {
  if (mime !== "image/svg+xml") {
    const blob = new Blob([decodeBase64(base64) as BlobPart], { type: mime });
    return objectUrls.create(blob);
  }
  const source = new TextDecoder("utf-8").decode(decodeBase64(base64));
  const clean = sanitizeSvgDocument(source);
  if (clean === null) {
    throw new Error("This SVG could not be sanitized, so it was not shown");
  }
  // data:, not blob: — see the note in sanitize.ts. Encoded rather than inlined raw so
  // no character in the document has to be URL-escaped correctly.
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(clean)))}`;
}

/**
 * Read or fetch an image, returning a handle the caller must release.
 *
 * Concurrent callers for the same key share one round trip — ten copies of the same
 * badge in a README must not be ten requests.
 */
export function acquireImage(target: ImageTarget): Promise<ImageHandle> {
  if (target.kind === "blocked") return Promise.reject(new Error(target.reason));

  const hit = retain(target.key);
  if (hit) return Promise.resolve(hit);

  const pending = inFlight.get(target.key);
  if (pending) return pending.then((h) => retain(h.key) ?? h);

  const href = target.kind === "local" ? target.path : target.url;
  const request = invoke<{ mime: string; data: string }>("image_load", {
    href,
    workspacePath: workspaceRoot,
  })
    .then((payload) => {
      const url = materialise(payload.mime, payload.data);
      // refs starts at 1 for the caller. An aborted caller still releases, which is
      // what keeps an abandoned resolve from pinning the entry forever.
      cache.set(target.key, { url, refs: 1 });
      evictIfNeeded();
      return { key: target.key, url };
    })
    .finally(() => {
      inFlight.delete(target.key);
    });

  inFlight.set(target.key, request);
  return request;
}

/**
 * The workspace root passed to Rust for confinement.
 *
 * Module-level rather than threaded through every call: the resolver is reached from a
 * DOM effect that has no store access, and Rust re-derives confinement from this anyway.
 */
let workspaceRoot: string | null = null;

export function setImageWorkspaceRoot(root: string | null): void {
  if (root === workspaceRoot) return;
  workspaceRoot = root;
  // Paths are workspace-relative in meaning even when absolute in form; a different
  // workspace is a different set of images.
  purgeImageCache();
}

/** Drop one path's entry, so an edited diagram is re-read rather than served stale. */
export function invalidateImage(path: string): void {
  const key = `local|${path}`;
  const entry = cache.get(key);
  if (!entry) return;
  release(entry.url);
  cache.delete(key);
}

/** Revoke everything. Called when a toggle goes off, or the workspace changes. */
export function purgeImageCache(): void {
  for (const entry of cache.values()) release(entry.url);
  cache.clear();
  inFlight.clear();
}

/** Test helper. */
export function __cacheSize(): number {
  return cache.size;
}
