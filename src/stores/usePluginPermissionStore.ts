import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { invoke } from "@tauri-apps/api/core";
import type { PluginPermission } from "../services/pluginPermissions";

export interface PluginGrant {
  permissions: PluginPermission[];
  /**
   * Origins the plugin was approved to reach. Stored alongside the permissions so
   * Settings → Plugins can show what a plugin can talk to, not only what it can do.
   */
  network?: string[];
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
  /** Hosts the plugin declared, already validated. Shown as "can send data to". */
  network: string[];
  /** Declared network entries julIDE refused, so the dialog can say they were dropped. */
  rejectedNetwork: string[];
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
  /**
   * Whether this exact manifest was approved, regardless of what it was approved for.
   *
   * A plugin can be approved for zero permissions — one that only wants network access,
   * for instance — and `granted()` cannot distinguish that from "never approved".
   */
  hasGrant: (pluginId: string, manifestHash: string) => boolean;
  grant: (
    pluginId: string,
    permissions: PluginPermission[],
    manifestHash: string,
    network?: string[],
  ) => Promise<void>;
  revoke: (pluginId: string) => Promise<void>;
  /** Queue a consent prompt and resolve once the user answers. */
  requestConsent: (request: Omit<PendingConsent, "resolve">) => Promise<boolean>;
  resolveNext: (approved: boolean) => void;
}

/**
 * Re-exported so existing imports keep working.
 *
 * The implementation lives in a dependency-free module because the plugin registry
 * vendors it byte-for-byte — see src/services/plugin/manifestHash.ts for why that
 * matters.
 */
export { computeManifestHash } from "../services/plugin/manifestHash";

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

    hasGrant: (pluginId, manifestHash) => get().grants[pluginId]?.manifestHash === manifestHash,

    grant: async (pluginId, permissions, manifestHash, network) => {
      set((s) => {
        s.grants[pluginId] = { permissions, manifestHash, network: network ?? [] };
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
