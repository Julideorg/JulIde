import type { ComponentType } from "react";

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
  render?: (container: HTMLElement) => (() => void) | void;
  component?: ComponentType;
  pluginId?: string;
}

// ─── Bottom Panel Contributions ─────────────────────────────────────────────

export interface BottomPanelContribution {
  id: string;
  label: string;
  order: number;
  render?: (container: HTMLElement) => (() => void) | void;
  component?: ComponentType;
  badge?: () => number | string | null;
  pluginId?: string;
}

// ─── Status Bar Item Contributions ──────────────────────────────────────────

export interface StatusBarItemContribution {
  id: string;
  text: string | (() => string);
  tooltip?: string;
  alignment: "left" | "center" | "right";
  order: number;
  onClick?: () => void;
  render?: (container: HTMLElement) => (() => void) | void;
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
  render?: (container: HTMLElement) => (() => void) | void;
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
  activationEvents?: string[];
  /**
   * Capabilities the plugin needs, e.g. `["workspace:read", "julia:run"]`.
   * The user approves these once; anything not listed is refused at the
   * `ctx.ipc.invoke` boundary. See src/services/pluginPermissions.ts for the catalog.
   */
  permissions?: string[];
  contributes?: {
    commands?: { id: string; label: string; shortcut?: string }[];
    settings?: { key: string; type: string; default: unknown; description: string }[];
  };
}

// ─── Plugin Context (passed to plugins on activation) ───────────────────────

export interface Disposable {
  dispose(): void;
}

export interface PluginContext {
  pluginId: string;

  commands: {
    register(id: string, label: string, handler: () => void | Promise<void>): Disposable;
    execute(id: string): Promise<void>;
  };

  ui: {
    registerSidebarPanel(opts: {
      id: string;
      label: string;
      icon: string;
      render: (el: HTMLElement) => (() => void) | void;
    }): Disposable;
    registerBottomPanel(opts: {
      id: string;
      label: string;
      render: (el: HTMLElement) => (() => void) | void;
    }): Disposable;
    registerStatusBarItem(opts: {
      id: string;
      text: string;
      alignment: "left" | "right";
      onClick?: () => void;
    }): Disposable;
    registerToolbarButton(opts: {
      id: string;
      label: string;
      icon: string;
      onClick: () => void;
    }): Disposable;
    showNotification(message: string, type: "info" | "warning" | "error"): void;
  };

  workspace: {
    getPath(): string | null;
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    onDidChangeFiles(callback: (paths: string[]) => void): Disposable;
  };

  editor: {
    getActiveFilePath(): string | null;
    getSelectedText(): string | null;
  };

  ipc: {
    invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
    listen(event: string, callback: (payload: unknown) => void): Disposable;
  };

  log: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
}
