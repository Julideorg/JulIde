/**
 * Classifying the links in a rendered markdown document.
 *
 * A README is untrusted input — it usually arrives with a cloned repository — so every
 * href is sorted into one of a handful of shapes before anything acts on it, rather than
 * being handed to a navigator or to the filesystem as-is. Pure functions, no DOM: this is
 * the part of the preview worth testing properly.
 */

export type MarkdownLink =
  /** http(s) — hand to `openExternal`, which opens the system browser. */
  | { kind: "external"; url: string }
  /** In-page `#heading` — scroll within the preview. */
  | { kind: "anchor"; id: string }
  /** A file inside the workspace — open it as a tab. */
  | { kind: "file"; path: string; anchor?: string }
  /** Resolved outside the workspace. Refuse, and say why. */
  | { kind: "blocked"; reason: string }
  /** `javascript:`, `data:`, `mailto:`, malformed — do nothing at all. */
  | { kind: "unsupported" };

/** Schemes we are willing to act on. Everything else is inert. */
const EXTERNAL_SCHEMES = ["http:", "https:"];

/** Anything of the form `word:` at the start is a scheme, including `javascript:`. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Directory part of a path, with no `node:path` — this module ships to the browser. */
function dirname(path: string): string {
  const normalised = path.replace(/\\/g, "/");
  const cut = normalised.lastIndexOf("/");
  return cut <= 0 ? "" : normalised.slice(0, cut);
}

/**
 * Collapse `.` and `..` segments.
 *
 * Done textually rather than by asking the filesystem, because the point is to decide
 * whether to *ask* at all. A symlink inside the workspace could still point outside it;
 * that is the backend's problem, and the backend is where a real boundary would live.
 */
function normalise(path: string): string {
  const absolute = path.startsWith("/");
  const out: string[] = [];
  for (const segment of path.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(segment);
  }
  return (absolute ? "/" : "") + out.join("/");
}

/** True when `path` is `root` itself or sits underneath it. */
function isInside(path: string, root: string): boolean {
  const r = normalise(root).replace(/\/$/, "");
  if (r === "") return true;
  return path === r || path.startsWith(r + "/");
}

/**
 * Decide what a markdown href means, relative to the document containing it.
 *
 * `workspacePath` confines relative links. It matters because the backend's
 * `fs_read_file` is an unguarded `std::fs::read_to_string`, so without this a README
 * could offer `[click me](../../../../etc/passwd)` and have it open in a tab. When there
 * is no workspace open there is nothing to escape from, so paths are allowed through.
 */
export function classifyMarkdownHref(
  href: string | null | undefined,
  docPath: string,
  workspacePath: string | null,
): MarkdownLink {
  const raw = href?.trim();
  if (!raw) return { kind: "unsupported" };

  if (raw.startsWith("#")) {
    const id = decodeFragment(raw.slice(1));
    return id ? { kind: "anchor", id } : { kind: "unsupported" };
  }

  if (HAS_SCHEME.test(raw)) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return { kind: "unsupported" };
    }
    return EXTERNAL_SCHEMES.includes(parsed.protocol)
      ? { kind: "external", url: parsed.toString() }
      : { kind: "unsupported" };
  }

  // Everything left is a path. Split the fragment and query off before resolving.
  const [beforeHash, ...hashParts] = raw.split("#");
  const anchor = decodeFragment(hashParts.join("#"));
  const pathPart = beforeHash.split("?")[0];
  if (!pathPart) return anchor ? { kind: "anchor", id: anchor } : { kind: "unsupported" };

  const decoded = decodeFragment(pathPart);
  if (!decoded) return { kind: "unsupported" };

  const isAbsolute = decoded.startsWith("/") || /^[a-z]:[\\/]/i.test(decoded);
  const resolved = normalise(isAbsolute ? decoded : `${dirname(docPath)}/${decoded}`);

  if (workspacePath && !isInside(resolved, workspacePath)) {
    return { kind: "blocked", reason: `${resolved} is outside the workspace` };
  }

  return anchor ? { kind: "file", path: resolved, anchor } : { kind: "file", path: resolved };
}

/** Percent-decode, tolerating the malformed escapes that hand-written links contain. */
function decodeFragment(value: string): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
