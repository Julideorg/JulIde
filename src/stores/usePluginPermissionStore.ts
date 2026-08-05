import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { invoke } from "@tauri-apps/api/core";
import type { PluginPermission } from "../services/pluginPermissions";

export interface PluginGrant {
  permissions: PluginPermission[];
  /**
   * Fingerprint of the manifest that was approved. If the plugin later changes what
   * it asks for — or is swapped out entirely — the hash stops matching and the user
   * is asked again rather than inheriting the old approval.
   */
  manifestHash: string;
}

export interface PendingConsent {
  pluginId: string;
  displayName: string;
  version: string;
  requested: PluginPermission[];
  unknown: string[];
  manifestHash: string;
  resolve: (approved: boolean) => void;
}

interface PluginPermissionStore {
  grants: Record<string, PluginGrant>;
  loaded: boolean;
  /** Consent prompts waiting on the user, oldest first. */
  queue: PendingConsent[];

  load: () => Promise<void>;
  /** Permissions currently granted to a plugin, honouring the manifest fingerprint. */
  granted: (pluginId: string, manifestHash: string) => PluginPermission[];
  grant: (pluginId: string, permissions: PluginPermission[], manifestHash: string) => Promise<void>;
  revoke: (pluginId: string) => Promise<void>;
  /** Queue a consent prompt and resolve once the user answers. */
  requestConsent: (request: Omit<PendingConsent, "resolve">) => Promise<boolean>;
  resolveNext: (approved: boolean) => void;
}

/**
 * Stable fingerprint of what a plugin is asking for.
 *
 * Deliberately covers the identity *and* the request: name, version, entry point, and
 * the sorted permission list. Bumping the version or asking for one more permission
 * both invalidate the previous approval.
 */
export function computeManifestHash(parts: {
  name: string;
  version: string;
  main: string;
  permissions: readonly string[];
}): string {
  const canonical = JSON.stringify({
    name: parts.name,
    version: parts.version,
    main: parts.main,
    permissions: [...parts.permissions].sort(),
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

export const usePluginPermissionStore = create<PluginPermissionStore>()(
  immer((set, get) => ({
    grants: {},
    loaded: false,
    queue: [],

    load: async () => {
      try {
        const grants = await invoke<Record<string, PluginGrant>>("plugin_grants_load");
        set((s) => {
          s.grants = grants ?? {};
          s.loaded = true;
        });
      } catch (e) {
        console.error("Failed to load plugin grants:", e);
        set((s) => {
          s.loaded = true;
        });
      }
    },

    granted: (pluginId, manifestHash) => {
      const grant = get().grants[pluginId];
      if (!grant) return [];
      // A changed manifest invalidates the grant until re-approved.
      if (grant.manifestHash !== manifestHash) return [];
      return grant.permissions;
    },

    grant: async (pluginId, permissions, manifestHash) => {
      set((s) => {
        s.grants[pluginId] = { permissions, manifestHash };
      });
      await invoke("plugin_grants_save", { grants: get().grants }).catch((e) => {
        console.error("Failed to persist plugin grants:", e);
      });
    },

    revoke: async (pluginId) => {
      set((s) => {
        delete s.grants[pluginId];
      });
      await invoke("plugin_grants_save", { grants: get().grants }).catch((e) => {
        console.error("Failed to persist plugin grants:", e);
      });
    },

    requestConsent: (request) =>
      new Promise<boolean>((resolve) => {
        set((s) => {
          s.queue.push({ ...request, resolve });
        });
      }),

    resolveNext: (approved) => {
      const next = get().queue[0];
      if (!next) return;
      set((s) => {
        s.queue.shift();
      });
      next.resolve(approved);
    },
  })),
);
