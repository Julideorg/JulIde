import type { ComponentType } from "react";

// ─── Panel content ──────────────────────────────────────────────────────────

/** Points at one view a plugin declared in its manifest. */
export interface PluginViewRef {
  pluginId: string;
  /** Unqualified, as declared. */
  viewId: string;
}

/**
 * How a contributed panel produces its content.
 *
 * There is deliberately no variant that hands a plugin a live `HTMLElement`. Built-ins
 * are React components in this realm; plugin content is an opaque-origin iframe and
 * nothing else. Making the third option unrepresentable is the point — a `render(el)`
 * callback was how a plugin reached the host DOM, and the type is what stops it coming
 * back the next time someone needs a quick escape hatch.
 */
export type PanelContent =
  { kind: "component"; component: ComponentType } | { kind: "plugin-view"; view: PluginViewRef };

// ─── Command Contributions ──────────────────────────────────────────────────

export interface CommandContribution {
  id: string;
  label: string;
  description?: string;
  shortcut?: string;
  category?: string;
  when?: () => boolean;
  execute: () => void | Promise<void>;
  pluginId?: string;
}

// ─── Sidebar Panel Contributions ────────────────────────────────────────────

export interface SidebarPanelContribution {
  id: string;
  label: string;
  icon: string;
  order: number;
  content: PanelContent;
  pluginId?: string;
}

// ─── Bottom Panel Contributions ─────────────────────────────────────────────

export interface BottomPanelContribution {
  id: string;
  label: string;
  order: number;
  content: PanelContent;
  /**
   * Built-ins compute it from live state; a plugin pushes a value over its port, so
   * for plugin panels this is data rather than a function.
   */
  badge?: (() => number | string | null) | number | string | null;
  pluginId?: string;
}

// ─── Status Bar Item Contributions ──────────────────────────────────────────

/**
 * Status bar items and toolbar buttons are host chrome, not plugin surfaces.
 *
 * They are pure data — text, a tooltip, an allowlisted icon name, a click — rendered by
 * julIDE's own components. A frame each would be a whole document with its own layout
 * and style for the word "Ready", it could not match the bar's typography, and there is
 * no capability in a string worth sandboxing. The click is relayed back to the owning
 * frame instead.
 */
export interface StatusBarItemContribution {
  id: string;
  /** Built-ins may compute it; plugin items are plain text, rendered as a text node. */
  text: string | (() => string);
  tooltip?: string;
  icon?: string;
  alignment: "left" | "center" | "right";
  order: number;
  onClick?: () => void;
  component?: ComponentType;
  pluginId?: string;
}

// ─── Toolbar Button Contributions ───────────────────────────────────────────

export interface ToolbarButtonContribution {
  id: string;
  label: string;
  icon: string;
  order: number;
  group: string;
  onClick?: () => void | Promise<void>;
  disabled?: () => boolean;
  visible?: () => boolean;
  component?: ComponentType;
  pluginId?: string;
}

// ─── Plugin Manifest ────────────────────────────────────────────────────────

export interface PluginManifest {
  name: string;
  version: string;
  displayName: string;
  description?: string;
  author?: string;
  main: string;
  /**
   * Which generation of the plugin API this was written against. Absent means 1, the
   * pre-sandbox API. See src/services/plugin/manifest.ts.
   */
  apiVersion?: number;
  activationEvents?: string[];
  /**
   * Origins the plugin may reach, e.g. `["https://api.github.com"]`. Enforced as the
   * `connect-src` of the plugin's own sandbox frame, so an undeclared host is not
   * reachable rather than merely undocumented. Absent means no network at all.
   */
  network?: string[];
  /**
   * Capabilities the plugin needs, e.g. `["workspace:read", "julia:run"]`.
   * The user approves these once; anything not listed is refused at the
   * `ctx.ipc.invoke` boundary. See src/services/pluginPermissions.ts for the catalog.
   */
  permissions?: string[];
  /**
   * Declarative contributions.
   *
   * Views must be declared rather than registered at runtime: the activity-bar entry
   * and the panel tab have to exist before the plugin's code has run, which is what
   * lets a view's frame be created lazily on first show instead of every plugin
   * spinning one up at startup. Validated by src/services/plugin/manifest.ts.
   */
  contributes?: {
    views?: { id: string; kind: "sidebar" | "panel"; title: string; icon: string }[];
    settings?: { key: string; type: string; default: unknown; description: string }[];
  };
}

/**
 * The shape of `ctx` now lives with the SDK that constructs it — `src/plugin-sdk/` —
 * because it is a description of what a plugin sees inside its frame, and the host no
 * longer builds that object at all. Keeping a second copy here would have meant two
 * definitions of the same API, drifting apart at the boundary they describe.
 */
export type { Disposable } from "../plugin-sdk/types";
