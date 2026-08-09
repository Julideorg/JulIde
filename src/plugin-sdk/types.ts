/**
 * The public API surface a plugin sees, for plugin authors to type against.
 *
 * Everything is a promise: `ctx` is a proxy over a `MessagePort` to a frame that has no
 * direct access to julIDE, so nothing here can be synchronous. That asynchrony is the
 * visible edge of the sandbox, not an implementation detail to hide.
 */

export interface Disposable {
  dispose(): void;
}

/** Icons the host will render. Anything else is refused at the boundary. */
export type PluginIcon = "Files" | "Search" | "GitBranch" | "Container" | "Puzzle" | "List" | "Eye";

export interface PluginViewContext {
  /** The view id, as declared in `contributes.views`. */
  readonly id: string;
  setTitle(title: string): Promise<void>;
  setBadge(badge: string | number | null): Promise<void>;
  onVisibilityChange(cb: (visible: boolean) => void): Disposable;
  onResize(cb: (size: { width: number; height: number }) => void): Disposable;
}

export interface PluginContext {
  readonly pluginId: string;
  readonly apiVersion: 2;

  /** Present only in a view frame — the frame rendering one declared view. */
  readonly view?: PluginViewContext;

  commands: {
    /** Registers `<pluginId>.<id>`. Only a background frame may call this. */
    register(id: string, label: string, handler: () => void | Promise<void>): Promise<Disposable>;
    /** Runs one of this plugin's own commands. Other plugins' and julIDE's are refused. */
    execute(id: string): Promise<void>;
  };

  ui: {
    setStatusBarItem(item: {
      id: string;
      text: string;
      tooltip?: string;
      icon?: PluginIcon;
      alignment?: "left" | "right";
    }): Promise<Disposable>;
    setToolbarButton(button: {
      id: string;
      label: string;
      icon: PluginIcon;
      enabled?: boolean;
      visible?: boolean;
    }): Promise<Disposable>;
    showNotification(message: string, type?: "info" | "warning" | "error"): void;
  };

  workspace: {
    getPath(): Promise<string | null>;
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    onDidChangeFiles(cb: (paths: string[]) => void): Promise<Disposable>;
  };

  editor: {
    getActiveFilePath(): Promise<string | null>;
    getSelectedText(): Promise<string | null>;
  };

  ipc: {
    /** Subject to the permission catalog — see docs/PLUGIN_API_V2.md. */
    invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
    listen(event: string, cb: (payload: unknown) => void): Promise<Disposable>;
  };

  log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}

/**
 * What a plugin assigns to `window.julide`.
 *
 * The host cannot import from an opaque origin, so this global is the handoff. A
 * background frame's `activate` runs once; `renderView` runs in each view frame, and
 * `ctx.view` tells it which one.
 */
export interface PluginModule {
  activate?(ctx: PluginContext): void | Promise<void>;
  renderView?(ctx: PluginContext): void | Promise<void>;
}
