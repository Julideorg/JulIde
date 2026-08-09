/**
 * Deciding what a plugin is allowed to do, before anything is created for it.
 *
 * Kept separate from `pluginHost` because that file now owns iframes, and a decision
 * this load-bearing should not need a browser to test. Nothing here has side effects
 * beyond the store it is handed and the reporter it is given.
 */

import { parsePermissions, unknownPermissions, type PluginPermission } from "../pluginPermissions";
import { describeOrigins } from "./network";
import type { ParsedManifest } from "./manifest";

export interface ConsentStore {
  granted(pluginId: string, manifestHash: string): PluginPermission[];
  /**
   * Whether an approval exists for this exact manifest.
   *
   * Distinct from `granted()` returning something, because a plugin can legitimately
   * be approved for zero permissions — a network-only plugin, say. Without this the
   * "already approved" test would be vacuously true for it and it would never prompt.
   */
  hasGrant(pluginId: string, manifestHash: string): boolean;
  grant(
    pluginId: string,
    permissions: PluginPermission[],
    manifestHash: string,
    network?: string[],
  ): Promise<void>;
  requestConsent(request: {
    pluginId: string;
    displayName: string;
    version: string;
    requested: PluginPermission[];
    unknown: string[];
    network: string[];
    rejectedNetwork: string[];
    manifestHash: string;
  }): Promise<boolean>;
}

export interface ResolvedGrant {
  granted: PluginPermission[];
  manifestHash: string;
}

/**
 * Resolve a plugin's grant, prompting only when the stored approval does not cover it.
 *
 * Returns null if the user declined — the caller must then create nothing at all, so
 * the plugin's code is never fetched, let alone evaluated.
 */
export async function resolveGrant(
  manifest: ParsedManifest,
  manifestHash: string,
  store: ConsentStore,
  report: (text: string) => void,
): Promise<ResolvedGrant | null> {
  const requested = parsePermissions(manifest.permissions);
  const unknown = unknownPermissions(manifest.permissions);
  const network = manifest.network;

  // A plugin asking for no permissions still needs consent if it wants the network:
  // sending the user's data somewhere is a grant, whether or not a Tauri command was
  // involved in gathering it. This is the case the old model had no concept of.
  if (requested.length === 0 && network.allowed.length === 0) {
    if (unknown.length > 0) {
      report(
        `Plugin "${manifest.displayName}" requests unknown permissions: ${unknown.join(", ")}. They were ignored.`,
      );
    }
    return { granted: [], manifestHash };
  }

  // Contents, not lengths. The manifest hash covers the sorted permission list so these
  // do line up in practice, but a boundary that holds only because of a property of a
  // non-cryptographic hash is one bug away from not holding. `requested` is handed back
  // rather than the stored list so a stale grant can never confer more than the
  // manifest currently declares.
  const alreadyGranted = store.granted(manifest.name, manifestHash);
  if (
    store.hasGrant(manifest.name, manifestHash) &&
    requested.every((p) => alreadyGranted.includes(p))
  ) {
    return { granted: requested, manifestHash };
  }

  const approved = await store.requestConsent({
    pluginId: manifest.name,
    displayName: manifest.displayName,
    version: manifest.version,
    requested,
    unknown,
    network: describeOrigins(network),
    rejectedNetwork: network.rejected.map((r) => r.value),
    manifestHash,
  });

  if (!approved) return null;

  await store.grant(manifest.name, requested, manifestHash, network.allowed);
  return { granted: requested, manifestHash };
}
