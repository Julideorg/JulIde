/**
 * The fingerprint a permission grant is bound to.
 *
 * Deliberately dependency-free — no zustand, no Tauri, no imports at all — because the
 * plugin registry vendors this file byte-for-byte. The registry publishes a
 * `manifestHash` for every plugin version so julIDE can tell a user, *before* they
 * install an update, whether it will ask for consent again. If the two implementations
 * drifted, that answer would be wrong in the direction that gets believed: "this update
 * needs no re-approval" when in fact it does.
 *
 * Keep it importable from a plain `bun test` with no setup. That property is what makes
 * the registry able to check its own arithmetic against julIDE's.
 */

/**
 * Stable fingerprint of what a plugin is asking for.
 *
 * Covers the identity *and* the whole request: name, version, entry point, API
 * generation, the sorted permission list, and the sorted network origins. Bumping the
 * version, asking for one more permission, or adding a host to reach all invalidate the
 * previous approval.
 *
 * `network` matters more than it looks: a plugin holding only `workspace:read` that
 * quietly gains an egress origin has become an exfiltration tool without touching its
 * permission list, and that must not inherit yesterday's approval.
 */
export function computeManifestHash(parts: {
  name: string;
  version: string;
  main: string;
  apiVersion?: number;
  permissions: readonly string[];
  network?: readonly string[];
}): string {
  const canonical = JSON.stringify({
    name: parts.name,
    version: parts.version,
    main: parts.main,
    apiVersion: parts.apiVersion ?? 1,
    permissions: [...parts.permissions].sort(),
    network: [...(parts.network ?? [])].sort(),
  });
  // Not cryptographic — this detects change, it does not defend against a local
  // attacker who could edit the grants file anyway.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < canonical.length; i++) {
    const c = canonical.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 + c, 0x85ebca6b) ^ (h2 >>> 13);
  }
  return ((h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)).padStart(16, "0");
}
