/**
 * The `network` field of `plugin.json`, and the `connect-src` it becomes.
 *
 * Until plugins ran in their own frame there was nowhere to enforce this: everything
 * shared julIDE's CSP, so widening egress for one plugin widened it for all of them and
 * for the IDE itself. A per-frame CSP makes a declared host list mean something, and
 * makes the absence of one mean something stronger — `connect-src 'none'`.
 *
 * Pure: it produces strings. The Rust side builds the actual header, and deliberately
 * re-validates rather than trusting anything the frontend passes it.
 */

import { toAscii } from "../ascii";

export interface NetworkPolicy {
  /** Origins that will appear in `connect-src`, normalised and deduplicated. */
  allowed: string[];
  /** Entries that were refused, paired with why, so the consent dialog can say so. */
  rejected: { value: string; reason: string }[];
}

/** How many origins one plugin may declare. */
const MAX_ORIGINS = 16;

/**
 * Parse a manifest's `network` array into a policy.
 *
 * Deliberately narrow. Every rejected form below is one a hostile manifest would like
 * accepted, and none of them has an honest use that an explicit origin does not cover:
 *
 * - **Wildcards** (`https://*.example.com`). CSP does support them, but a subdomain
 *   wildcard is only as trustworthy as the sloppiest subdomain of that domain, and it
 *   is unreviewable — nobody can tell what it will resolve to next year.
 * - **Bare schemes** (`https:`) — that is every host on the internet, written to look
 *   like a restriction.
 * - **`http://`** for anything but loopback. The user is being asked to approve a data
 *   flow; approving it in cleartext is not a thing to offer.
 * - **Paths, query strings, credentials.** `connect-src` matches on origin, so a path
 *   is ignored by the browser while reading, to a human, like a limit that was applied.
 *   That gap is the problem.
 * - **`data:`, `blob:`, `filesystem:`** — not egress, and listing them muddies what the
 *   consent dialog is telling the user.
 */
export function parseNetworkOrigins(raw: readonly string[] | undefined): NetworkPolicy {
  const allowed: string[] = [];
  const rejected: NetworkPolicy["rejected"] = [];
  if (!raw) return { allowed, rejected };

  const seen = new Set<string>();

  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim() === "") {
      rejected.push({ value: String(entry), reason: "not a non-empty string" });
      continue;
    }
    const value = entry.trim();

    if (allowed.length >= MAX_ORIGINS) {
      rejected.push({ value, reason: `more than ${MAX_ORIGINS} origins declared` });
      continue;
    }
    if (value.includes("*")) {
      rejected.push({ value, reason: toAscii("wildcards are not accepted — name each host") });
      continue;
    }

    let url: URL;
    try {
      url = new URL(value);
    } catch {
      rejected.push({ value, reason: "not a valid absolute URL" });
      continue;
    }

    if (url.username !== "" || url.password !== "") {
      rejected.push({ value, reason: "must not embed credentials" });
      continue;
    }
    if (url.hostname === "") {
      rejected.push({ value, reason: "must name a host" });
      continue;
    }

    const isLoopback = isLoopbackHost(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
      rejected.push({
        value,
        reason:
          url.protocol === "http:"
            ? "plain http is only accepted for localhost"
            : `scheme "${url.protocol}" is not network egress`,
      });
      continue;
    }

    // `connect-src` matches on origin, so anything past it is decoration. Rejecting
    // rather than silently trimming: a manifest that says `https://api.example.com/v1`
    // is claiming a narrower grant than it is getting, and the user reads the manifest.
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      rejected.push({
        value,
        reason: toAscii("must be a bare origin — a path or query is not enforced and misleads"),
      });
      continue;
    }

    const origin = url.origin;
    if (seen.has(origin)) continue;
    seen.add(origin);
    allowed.push(origin);
  }

  return { allowed, rejected };
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  );
}

/**
 * The `connect-src` value for a policy.
 *
 * A plugin that declared nothing gets `'none'`, not the host's default — the whole
 * point is that silence means no egress rather than inherited egress.
 */
export function connectSrc(policy: NetworkPolicy): string {
  return policy.allowed.length === 0 ? "'none'" : policy.allowed.join(" ");
}

/** Host names for the consent dialog — an origin without the scheme noise. */
export function describeOrigins(policy: NetworkPolicy): string[] {
  return policy.allowed.map((o) => {
    try {
      return new URL(o).host;
    } catch {
      return o;
    }
  });
}
