import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import * as marketplace from "../services/marketplace";
import { pluginHost } from "../services/pluginHost";
import type { AvailableUpdate, RegistryEntry, RegistryIndex } from "../types/marketplace";

type Busy = "installing" | "updating" | "uninstalling";

interface MarketplaceStore {
  index: RegistryIndex | null;
  loading: boolean;
  error: string;
  query: string;
  updates: AvailableUpdate[];
  /** Per-plugin, so one slow install does not grey out the whole list. */
  busy: Record<string, Busy>;

  setQuery: (q: string) => void;
  loadIndex: (force?: boolean) => Promise<void>;
  checkUpdates: () => Promise<void>;
  install: (entry: RegistryEntry) => Promise<void>;
  uninstall: (name: string) => Promise<void>;
  results: () => RegistryEntry[];
}

export const useMarketplaceStore = create<MarketplaceStore>()(
  immer((set, get) => ({
    index: null,
    loading: false,
    error: "",
    query: "",
    updates: [],
    busy: {},

    setQuery: (q) =>
      set((s) => {
        s.query = q;
      }),

    loadIndex: async (force = false) => {
      set((s) => {
        s.loading = true;
        s.error = "";
      });
      try {
        const index = await marketplace.fetchIndex(force);
        set((s) => {
          s.index = index;
          s.loading = false;
        });
      } catch (e) {
        // The registry being unreachable — or unsigned — is reported, never thrown. The
        // rest of the IDE does not depend on it.
        set((s) => {
          s.loading = false;
          s.error = e instanceof Error ? e.message : String(e);
        });
      }
    },

    checkUpdates: async () => {
      try {
        const updates = await marketplace.checkUpdates();
        set((s) => {
          s.updates = updates;
        });
      } catch {
        // A failed update check is not worth interrupting anyone over.
      }
    },

    install: async (entry) => {
      const version = entry.latest?.version;
      if (!version) return;

      set((s) => {
        s.busy[entry.name] = s.updates.some((u) => u.name === entry.name)
          ? "updating"
          : "installing";
        s.error = "";
      });

      try {
        const result = await marketplace.install(entry.name, version);
        // Activation goes through the same path as a plugin found on disk, so consent
        // still happens at the one choke point rather than being granted at install.
        await pluginHost.activatePlugin(result.manifest);
        await get().checkUpdates();
      } catch (e) {
        set((s) => {
          s.error = e instanceof Error ? e.message : String(e);
        });
      } finally {
        set((s) => {
          delete s.busy[entry.name];
        });
      }
    },

    uninstall: async (name) => {
      set((s) => {
        s.busy[name] = "uninstalling";
      });
      try {
        // Tear the plugin down before its files disappear, so its frames and
        // subscriptions are released rather than pointing at nothing.
        await pluginHost.deactivatePlugin(name);
        await marketplace.uninstall(name);
        await get().checkUpdates();
      } catch (e) {
        set((s) => {
          s.error = e instanceof Error ? e.message : String(e);
        });
      } finally {
        set((s) => {
          delete s.busy[name];
        });
      }
    },

    results: () => marketplace.searchIndex(get().index?.plugins ?? [], get().query),
  })),
);
