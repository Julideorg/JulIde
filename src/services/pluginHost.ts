import { invoke } from "@tauri-apps/api/core";
import { useIdeStore } from "../stores/useIdeStore";
import { computeManifestHash, usePluginPermissionStore } from "../stores/usePluginPermissionStore";
import { resolveGrant } from "./plugin/consent";
import { parseManifest, type ParsedManifest } from "./plugin/manifest";
import { createPluginFrame, type FrameHandle } from "./plugin/bridge";
import { createHostDeps } from "./plugin/hostDeps";
import { pluginRevocations } from "./plugin/revocations";
import { usePluginStore } from "../stores/usePluginStore";
import type { PluginPermission } from "./pluginPermissions";
import type { PluginManifest, PluginViewRef } from "../types/plugin";

interface LoadedPlugin {
  manifest: ParsedManifest;
  background: FrameHandle;
  granted: readonly PluginPermission[];
  /** One per currently-mounted view, keyed by the unqualified view id. */
  views: Map<string, FrameHandle>;
  active: boolean;
  error?: string;
}

/**
 * Where background frames live.
 *
 * Off-screen rather than `display: none`: WebKitGTK throttles timers in frames it
 * considers invisible, and a plugin that set an interval would find it running at an
 * unpredictable rate. One pixel, far off to the left, is still "rendered".
 */
function backgroundHost(): HTMLElement {
  let host = document.getElementById("plugin-frames");
  if (!host) {
    host = document.createElement("div");
    host.id = "plugin-frames";
    host.style.cssText =
      "position:absolute;left:-10000px;top:0;width:1px;height:1px;overflow:hidden";
    document.body.appendChild(host);
  }
  return host;
}

class PluginHost {
  private plugins = new Map<string, LoadedPlugin>();
  /** Plugins that could not be loaded, kept so Settings can explain why. */
  private failures = new Map<
    string,
    { manifest: PluginManifest; error: string; incompatible: boolean }
  >();

  async discoverAndLoadAll(): Promise<void> {
    try {
      // Grants must be loaded before any plugin activates, otherwise a plugin that
      // was previously approved would come up with no permissions.
      await usePluginPermissionStore.getState().load();

      // Bounded, so a hung network cannot delay the IDE coming up. On timeout the last
      // verified feed still applies — that is the fail-open half of the policy.
      await pluginRevocations.refresh({ budgetMs: 5000 });

      const manifests = await invoke<PluginManifest[]>("plugin_scan");
      for (const raw of manifests) {
        if (this.plugins.has(raw.name)) continue;

        const shouldActivate =
          !raw.activationEvents ||
          raw.activationEvents.length === 0 ||
          raw.activationEvents.includes("*");

        if (shouldActivate) await this.activatePlugin(raw);
      }
    } catch (e) {
      console.warn("Plugin discovery failed:", e);
    }
  }

  private async resolvePermissions(manifest: ParsedManifest) {
    const manifestHash = computeManifestHash({
      name: manifest.name,
      version: manifest.version,
      main: manifest.main,
      apiVersion: manifest.apiVersion,
      permissions: manifest.permissions,
      network: manifest.network.allowed,
    });
    return resolveGrant(manifest, manifestHash, usePluginPermissionStore.getState(), (text) =>
      useIdeStore.getState().appendOutput({ kind: "info", text }),
    );
  }

  async activatePlugin(raw: PluginManifest): Promise<void> {
    // Checked here rather than in discovery, because this is the one door: the
    // marketplace calls it after an install too, and a second path would eventually
    // forget to check.
    const revoked = pluginRevocations.isRevoked(raw.name, raw.version);
    if (revoked) {
      // The grant goes as well as the load. Leaving it would mean a revoked plugin
      // silently reactivates the moment the advisory is withdrawn or the feed is
      // unreachable.
      await usePluginPermissionStore.getState().revoke(raw.name);
      const detail = revoked.advisory ? ` See ${revoked.advisory}` : "";
      useIdeStore.getState().appendOutput({
        kind: "stderr",
        text: `Plugin "${raw.name}" ${raw.version} was blocked by a security advisory: ${revoked.reason}${detail}`,
      });
      if (revoked.action === "disable") return;
    }

    const parsed = parseManifest(raw);
    if (!parsed.ok) {
      // An incompatible plugin is not an error the user caused, so it is recorded for
      // Settings rather than shouted into the Output panel on every launch.
      this.failures.set(raw.name, {
        manifest: raw,
        error: parsed.errors.join(" "),
        incompatible: parsed.incompatible,
      });
      if (!parsed.incompatible) {
        useIdeStore.getState().appendOutput({
          kind: "stderr",
          text: `Plugin "${raw.name}" has an invalid plugin.json: ${parsed.errors.join(" ")}`,
        });
      }
      return;
    }

    const manifest = parsed.manifest;
    for (const warning of parsed.warnings) {
      useIdeStore
        .getState()
        .appendOutput({ kind: "info", text: `Plugin "${manifest.displayName}": ${warning}` });
    }

    const resolved = await this.resolvePermissions(manifest);
    if (!resolved) {
      useIdeStore.getState().appendOutput({
        kind: "info",
        text: `Plugin "${manifest.displayName}" was not loaded — permissions declined.`,
      });
      return;
    }

    // The frame is created only now. Its document is served with the plugin's own CSP,
    // it has an opaque origin, and it receives no port until it has proved which frame
    // it is — so the plugin's top-level code runs with nothing to reach.
    // Declared const and referenced from the closure below: the arrow body is not
    // evaluated until the frame asks the host to run a command, long after this binds.
    const frame: FrameHandle = createPluginFrame({
      pluginId: manifest.name,
      role: "background",
      granted: resolved.granted,
      container: backgroundHost(),
      onError: (message) => {
        useIdeStore.getState().appendOutput({ kind: "stderr", text: message });
      },
      deps: {
        ...createHostDeps({
          pluginId: manifest.name,
          executeInFrame: (commandId) => frame.execute(commandId),
        }),
        emitToFrame: () => {
          // Replaced by the bridge, which owns the port.
        },
      },
    });

    const loaded: LoadedPlugin = {
      manifest,
      background: frame,
      granted: resolved.granted,
      views: new Map(),
      active: false,
    };
    this.plugins.set(manifest.name, loaded);

    // Views are registered from the manifest, before the plugin has run. Their frames
    // are created lazily, when one is actually shown.
    this.registerViews(manifest);

    try {
      await frame.ready;
      loaded.active = true;
      console.log(`Plugin activated: ${manifest.displayName} v${manifest.version}`);
    } catch (e) {
      loaded.error = e instanceof Error ? e.message : String(e);
    }
  }

  private registerViews(manifest: ParsedManifest): void {
    const store = usePluginStore.getState();
    for (const view of manifest.views) {
      const id = `${manifest.name}.${view.id}`;
      const content = {
        kind: "plugin-view" as const,
        view: { pluginId: manifest.name, viewId: view.id },
      };
      if (view.kind === "sidebar") {
        store.registerSidebarPanel({
          id,
          label: view.title,
          icon: view.icon,
          order: 100, // plugins sort after every built-in panel
          content,
          pluginId: manifest.name,
        });
      } else {
        store.registerBottomPanel({
          id,
          label: view.title,
          order: 100,
          content,
          pluginId: manifest.name,
        });
      }
    }
  }

  /**
   * Create the frame for a view the user has just opened.
   *
   * Returns null when the plugin is not loaded or never declared this view — a stale
   * contribution left in the store, which should not throw at render time.
   */
  async mountView(ref: PluginViewRef, container: HTMLElement): Promise<FrameHandle | null> {
    const plugin = this.plugins.get(ref.pluginId);
    if (!plugin) return null;
    if (!plugin.manifest.views.some((v) => v.id === ref.viewId)) return null;

    // A view remounting while its old frame is still alive would leave the first one
    // orphaned, holding a port and a subscription each.
    await plugin.views.get(ref.viewId)?.destroy();

    const frame: FrameHandle = createPluginFrame({
      pluginId: ref.pluginId,
      role: "view",
      viewId: ref.viewId,
      granted: plugin.granted,
      container,
      onError: (message) => {
        useIdeStore.getState().appendOutput({ kind: "stderr", text: message });
      },
      deps: {
        ...createHostDeps({
          pluginId: ref.pluginId,
          executeInFrame: (commandId) => frame.execute(commandId),
        }),
        ...this.viewDeps(ref),
        emitToFrame: () => {},
      },
    });

    plugin.views.set(ref.viewId, frame);
    return frame;
  }

  /** Title and badge updates from a view frame land on its own contribution. */
  private viewDeps(ref: PluginViewRef) {
    const qualified = `${ref.pluginId}.${ref.viewId}`;
    const store = () => usePluginStore.getState();
    return {
      setViewTitle: (_viewId: string, title: string) => {
        const sidebar = store().sidebarPanels.find((p) => p.id === qualified);
        if (sidebar) {
          store().registerSidebarPanel({ ...sidebar, label: title });
          return;
        }
        const bottom = store().bottomPanels.find((p) => p.id === qualified);
        if (bottom) store().registerBottomPanel({ ...bottom, label: title });
      },
      setViewBadge: (_viewId: string, badge: string | number | null) => {
        const bottom = store().bottomPanels.find((p) => p.id === qualified);
        // Sidebar panels have no badge slot; silently ignoring is kinder than an error
        // for something this cosmetic.
        if (bottom) store().registerBottomPanel({ ...bottom, badge });
      },
    };
  }

  async deactivatePlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) return;

    for (const view of plugin.views.values()) await view.destroy();
    plugin.views.clear();
    await plugin.background.destroy();

    // The view contributions came from the manifest, not from the frame, so the
    // dispatcher's teardown does not know about them.
    const store = usePluginStore.getState();
    for (const view of plugin.manifest.views) {
      const id = `${name}.${view.id}`;
      if (view.kind === "sidebar") store.unregisterSidebarPanel(id);
      else store.unregisterBottomPanel(id);
    }

    plugin.active = false;
  }

  /**
   * Strip a running plugin's capabilities and tear down what it contributed.
   *
   * Clearing the stored grant is the permission store's job; this is the in-memory
   * half. Closing the port is what makes it total — the plugin still holds its end,
   * but there is nothing on the other side of it any more.
   */
  async revokePlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) return;
    plugin.background.revoke();
    await this.deactivatePlugin(name);
  }

  async deactivateAll(): Promise<void> {
    for (const name of this.plugins.keys()) await this.deactivatePlugin(name);
  }

  getPlugins(): Array<{
    name: string;
    displayName: string;
    version: string;
    active: boolean;
    error?: string;
    incompatible?: boolean;
  }> {
    const loaded = Array.from(this.plugins.values()).map((p) => ({
      name: p.manifest.name,
      displayName: p.manifest.displayName,
      version: p.manifest.version,
      active: p.active,
      error: p.error,
    }));
    const failed = Array.from(this.failures.values()).map((f) => ({
      name: f.manifest.name,
      displayName: f.manifest.displayName ?? f.manifest.name,
      version: f.manifest.version ?? "",
      active: false,
      error: f.error,
      incompatible: f.incompatible,
    }));
    return [...loaded, ...failed];
  }

  isActive(name: string): boolean {
    return this.plugins.get(name)?.active ?? false;
  }
}

// Singleton instance
export const pluginHost = new PluginHost();
