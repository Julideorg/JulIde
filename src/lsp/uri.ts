/**
 * Conversion between OS paths and the `file:` URIs the language server speaks.
 *
 * These used to be built by hand as `` `file://${path}` ``, which produces a
 * string that is not a URI as soon as the path is anything but plain ASCII with
 * no spaces. On Windows it is never a URI: `C:\Users\me` becomes
 * `file://C:\Users\me`, where a strict parser reads `C:` as an authority and
 * then chokes on the backslash. `lsp-types` parses every URI field through
 * `fluent-uri`, so Fatou answered the handshake with
 * "unexpected character at index 9" — index 9 being exactly that backslash —
 * and the server died before it ever started (issue #38). A path containing a
 * space, `#`, `%` or a non-ASCII character failed the same way on every
 * platform.
 */

/** Already a URI (`file://…`, `untitled:…` is handled separately below). */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

const FILE_PREFIX = "file://";

/**
 * The only characters Monaco's URI encoder leaves literal — RFC 3986's
 * "unreserved" set. Everything else in a path, including `:` and every
 * sub-delim, comes back percent-encoded.
 *
 * Matching that set exactly is load-bearing, not cosmetic, and it is narrower
 * than it looks — narrower than `encodeURIComponent`'s, which spares `!'()*`.
 * Monaco normalizes a URI when it parses one, so `pathToUri(p)` has to already
 * equal `monaco.Uri.parse(pathToUri(p)).toString()`; the test file pins that
 * against the real Monaco. Editor models are keyed by that string, and the
 * providers read a document's URI back off its model — encode one character
 * differently from Monaco and the editor starts asking the server about a
 * document it was never told was open.
 */
const UNRESERVED = /[A-Za-z0-9\-._~]/;

/**
 * Percent-encode one character, Monaco's way.
 *
 * `encodeURIComponent` is the right tool for the UTF-8 multi-byte cases and the
 * wrong one for `!'()*`, which it passes through and Monaco does not.
 */
function percentEncode(ch: string): string {
  const encoded = encodeURIComponent(ch);
  if (encoded !== ch) return encoded;
  return `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
}

function encodePath(path: string): string {
  let out = "";
  // Iterating with for..of walks code points, so a character outside the BMP is
  // handed to encodeURIComponent whole rather than as two broken halves.
  for (const ch of path) out += ch === "/" || UNRESERVED.test(ch) ? ch : percentEncode(ch);
  return out;
}

/** Same encoding for the host, which Monaco additionally lower-cases. */
function encodeAuthority(authority: string): string {
  let out = "";
  for (const ch of authority.toLowerCase()) out += UNRESERVED.test(ch) ? ch : percentEncode(ch);
  return out;
}

/**
 * Turn an absolute OS path into a `file:` URI.
 *
 * Windows drive letters are lower-cased (`C:\x` → `file:///c%3A/x`) to match
 * what Monaco and VS Code produce, and a UNC path becomes an authority
 * (`\\srv\share\x` → `file://srv/share/x`). A string that is already a URI is
 * returned untouched, so this is safe to apply twice.
 */
export function pathToUri(path: string): string {
  if (HAS_SCHEME.test(path)) return path;

  const slashed = path.replace(/\\/g, "/");

  // UNC: the host is the URI's authority, and the share is the first segment.
  if (slashed.startsWith("//")) {
    const rest = slashed.slice(2);
    const cut = rest.indexOf("/");
    const authority = cut === -1 ? rest : rest.slice(0, cut);
    const remainder = cut === -1 ? "" : rest.slice(cut);
    return `${FILE_PREFIX}${encodeAuthority(authority)}${encodePath(remainder)}`;
  }

  let p = slashed;
  if (/^[a-zA-Z]:/.test(p)) {
    p = `/${p[0].toLowerCase()}${p.slice(1)}`;
  } else if (!p.startsWith("/")) {
    // Not expected — every path julIDE holds comes from the OS and is absolute
    // — but a leading slash is what keeps the result a valid URI rather than
    // letting the first segment be mistaken for an authority.
    p = `/${p}`;
  }
  return `${FILE_PREFIX}${encodePath(p)}`;
}

/**
 * `decodeURIComponent` that survives a stray `%`.
 *
 * It throws on a malformed escape, and this runs inside the `publishDiagnostics`
 * handler — a server that sent one badly-formed URI would otherwise take the
 * whole subscription down with it. A URI we cannot decode is still more useful
 * left alone than replaced by an exception.
 */
function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Turn a `file:` URI back into an OS-native path.
 *
 * "Native" matters: the result is compared against `EditorTab.path` and against
 * the paths Rust puts in `Problem.file`, both of which use the platform's own
 * separator. Anything that is not a `file:` URI (`untitled:`, `inmemory:`) is
 * returned as-is rather than mangled into a path that does not exist.
 */
export function uriToPath(uri: string): string {
  if (!uri.startsWith(FILE_PREFIX)) return uri;

  const rest = uri.slice(FILE_PREFIX.length);
  const cut = rest.indexOf("/");
  const authority = decode(cut === -1 ? rest : rest.slice(0, cut));
  const path = decode(cut === -1 ? "" : rest.slice(cut));

  // An authority means the URI came from a UNC path.
  if (authority) return `\\\\${authority}${path.replace(/\//g, "\\")}`;

  // `/c:/x` → `C:\x`. Upper-cased because that is how Windows itself renders a
  // drive, and these strings are shown to the user in the Problems panel.
  if (/^\/[a-zA-Z]:/.test(path)) {
    return `${path[1].toUpperCase()}${path.slice(2).replace(/\//g, "\\")}`;
  }
  return path;
}

/**
 * Last component of an OS path.
 *
 * Lives here because it is the same problem: `path.split("/").pop()` returns
 * the whole string on Windows, where the separator is a backslash.
 */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}
