import { invoke } from "@tauri-apps/api/core";
import { createPluginContext } from "./pluginContext";
import { useIdeStore } from "../stores/useIdeStore";
import {
  computeManifestHash,
  usePluginPermissionStore,
} from "../stores/usePluginPermissionStore";
import { parsePermissions, unknownPermissions } from "./pluginPermissions";
import type { PluginManifest, PluginContext } from "../types/plugin";

interface LoadedPlugin {
  manifest: PluginManifest;
  context: PluginContext;
  disposeAll: () => void;
  module: { activate?: (ctx: PluginContext) => void | Promise<void>; deactivate?: () => void | Promise<void> };
  active: boolean;
  error?: string;
}

class PluginHost {
  private plugins = new Map<string, LoadedPlugin>();

  async discoverAndLoadAll(): Promise<void> {
    try {
      // Grants must be loaded before any plugin activates, otherwise a plugin that
      // was previously approved would come up with no permissions.
      await usePluginPermissionStore.getState().load();

      const manifests = await invoke<PluginManifest[]>("plugin_scan");
      for (const manifest of manifests) {
        if (this.plugins.has(manifest.name)) continue;

        // Only auto-activate plugins with "*" or empty activation events
        const shouldActivate =
          !manifest.activationEvents ||
          manifest.activationEvents.length === 0 ||
          manifest.activationEvents.includes("*");

        if (shouldActivate) {
          await this.activatePlugin(manifest);
        }
      }
    } catch (e) {
      console.warn("Plugin discovery failed:", e);
    }
  }

  /**
   * Resolve which permissions this plugin may use, prompting the user if the request
   * has not been approved for this exact manifest.
   *
   * Returns null if the user declined, in which case the plugin is not loaded at all.
   * A plugin requesting nothing needs no prompt — it still runs, it just cannot reach
   * any Tauri command.
   */
  private async resolvePermissions(manifest: PluginManifest) {
    const store = usePluginPermissionStore.getState();
    const requested = parsePermissions(manifest.permissions);
    const unknown = unknownPermissions(manifest.permissions);
    const manifestHash = computeManifestHash({
      name: manifest.name,
      version: manifest.version,
      main: manifest.main,
      permissions: manifest.permissions ?? [],
    });

    if (requested.length === 0) {
      if (unknown.length > 0) {
        useIdeStore.getState().appendOutput({
          kind: "info",
          text: `Plugin "${manifest.displayName}" requests unknown permissions: ${unknown.join(", ")}. They were ignored.`,
        });
      }
      return { granted: [], manifestHash };
    }

    const alreadyGranted = store.granted(manifest.name, manifestHash);
    if (alreadyGranted.length === requested.length) {
      return { granted: alreadyGranted, manifestHash };
    }

    const approved = await store.requestConsent({
      pluginId: manifest.name,
      displayName: manifest.displayName,
      version: manifest.version,
      requested,
      unknown,
      manifestHash,
    });

    if (!approved) return null;

    await store.grant(manifest.name, requested, manifestHash);
    return { granted: requested, manifestHash };
  }

  async activatePlugin(manifest: PluginManifest): Promise<void> {
    const resolved = await this.resolvePermissions(manifest);
    if (!resolved) {
      useIdeStore.getState().appendOutput({
        kind: "info",
        text: `Plugin "${manifest.displayName}" was not loaded — permissions declined.`,
      });
      return;
    }

    const { context, disposeAll } = createPluginContext(manifest.name, resolved.granted);

    try {
      // Read the plugin's entry JS file
      const source = await invoke<string>("plugin_read_entry", {
        pluginName: manifest.name,
      });

      // Create a module from the source code using a blob URL
      const blob = new Blob([source], { type: "application/javascript" });
      const blobUrl = URL.createObjectURL(blob);

      let module: LoadedPlugin["module"];
      try {
        module = await import(/* @vite-ignore */ blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }

      const loaded: LoadedPlugin = {
        manifest,
        context,
        disposeAll,
        module,
        active: false,
      };

      this.plugins.set(manifest.name, loaded);

      // Call activate if exported
      if (typeof module.activate === "function") {
        await module.activate(context);
      }

      loaded.active = true;
      console.log(`Plugin activated: ${manifest.displayName} v${manifest.version}`);
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      console.error(`Failed to activate plugin ${manifest.name}:`, errorMsg);
      useIdeStore.getState().appendOutput({
        kind: "stderr",
        text: `Plugin "${manifest.displayName}" failed to activate: ${errorMsg}`,
      });

      this.plugins.set(manifest.name, {
        manifest,
        context,
        disposeAll,
        module: {},
        active: false,
        error: errorMsg,
      });
    }
  }

  async deactivatePlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) return;

    try {
      if (plugin.active && typeof plugin.module.deactivate === "function") {
        await plugin.module.deactivate();
      }
    } catch (e) {
      console.error(`Error deactivating plugin ${name}:`, e);
    }

    plugin.disposeAll();
    plugin.active = false;
  }

  async deactivateAll(): Promise<void> {
    for (const name of this.plugins.keys()) {
      await this.deactivatePlugin(name);
    }
  }

  getPlugins(): Array<{ name: string; displayName: string; version: string; active: boolean; error?: string }> {
    return Array.from(this.plugins.values()).map((p) => ({
      name: p.manifest.name,
      displayName: p.manifest.displayName,
      version: p.manifest.version,
      active: p.active,
      error: p.error,
    }));
  }

  isActive(name: string): boolean {
    return this.plugins.get(name)?.active ?? false;
  }
}

// Singleton instance
export const pluginHost = new PluginHost();
