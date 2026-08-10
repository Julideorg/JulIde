import { sanitizeMarkdown } from "../markdown/sanitize";
import type { CellOutput } from "../stores/useNotebookStore";

/**
 * Turning a Julia MIME bundle into something renderable, without putting bytes in the
 * store.
 *
 * `PlotPane` does the base64 → Blob → object URL dance correctly today, but it only ever
 * holds one URL at a time. Across N cells rendering simultaneously that discipline is
 * much easier to lose, so revocation is centralized here and keyed by output id:
 * clearing a cell, deleting a cell, restarting the kernel and resetting the store all
 * release through one function.
 */

const urls = new Map<string, string>();

/** Injectable, because `URL.createObjectURL` does not exist under `bun test`. */
let objectUrls = {
  create: (blob: Blob): string => URL.createObjectURL(blob),
  revoke: (url: string): void => URL.revokeObjectURL(url),
};

export function __setObjectUrlImpl(impl: typeof objectUrls): () => void {
  const previous = objectUrls;
  objectUrls = impl;
  return () => {
    objectUrls = previous;
  };
}

/** Mime types worth rendering as an image, in the order we prefer them. */
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/svg+xml"];

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Build a renderable output from a bundle, registering any object URL under `id`.
 *
 * The bundle is the driver's `data` map: binary mimes base64, text mimes verbatim.
 */
export function bundleToOutput(
  id: string,
  kind: "display" | "result",
  data: Record<string, string>,
  executionCount?: number,
): CellOutput {
  const output: CellOutput = { id, kind, executionCount };

  const mime = IMAGE_MIMES.find((m) => m in data);
  if (mime) {
    try {
      // SVG arrives as text and is inert only after sanitizing — same reasoning as the
      // markdown preview's images: an object URL is navigable and inherits our origin.
      const blob =
        mime === "image/svg+xml"
          ? new Blob([data[mime]], { type: "image/svg+xml" })
          : new Blob([decodeBase64(data[mime]) as BlobPart], { type: mime });
      const url = objectUrls.create(blob);
      urls.set(id, url);
      output.imageUrl = url;
    } catch {
      // Fall through to text; a broken image must not lose the rest of the bundle.
    }
  }

  if (!output.imageUrl && typeof data["text/html"] === "string") {
    // Through the same allowlist the markdown preview uses. Julia packages emit HTML
    // tables (DataFrames) constantly, and that markup is not more trusted than a README.
    output.html = sanitizeMarkdown(data["text/html"]);
  }

  if (typeof data["text/plain"] === "string") {
    output.text = data["text/plain"];
  }
  return output;
}

/** Release the object URLs held by these outputs. */
export function releaseOutputs(outputs: CellOutput[]): void {
  for (const output of outputs) {
    const url = urls.get(output.id);
    if (!url) continue;
    objectUrls.revoke(url);
    urls.delete(output.id);
  }
}

/** Release everything. Kernel restart, store reset, app teardown. */
export function releaseAllOutputs(): void {
  for (const url of urls.values()) objectUrls.revoke(url);
  urls.clear();
}

/** Test helper. */
export function __liveUrlCount(): number {
  return urls.size;
}
