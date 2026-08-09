/**
 * Every capability a sandboxed plugin has, in one function.
 *
 * The frame can only send messages, so this is the whole attack surface: if a method is
 * not here, a plugin cannot do it. That makes the module worth keeping pure — it takes a
 * decoded request and returns a response, with `invoke`, the stores and the DOM all
 * injected. Roughly all of the security-relevant logic in the sandbox is therefore a
 * plain function testable under `bun test`, which has no browser.
 *
 * The gates themselves are not re-implemented here: `assertCommandAllowed` and
 * `assertEventAllowed` are the same ones the pre-sandbox context used, so there is one
 * catalog and one fail-closed rule rather than two that can drift.
 */

import {
  assertCommandAllowed,
  assertEventAllowed,
  PluginPermissionError,
  type PluginPermission,
} from "../pluginPermissions";
import { PLUGIN_ICONS, type PluginIcon } from "./manifest";
import { serializeError, type RpcRequest, type RpcResponse } from "./protocol";

/**
 * Which kind of frame is asking.
 *
 * A plugin's bundle runs in both, so the role is what stops a view frame from
 * registering commands four times over when the user opens four panels.
 */
export type FrameRole = "background" | "view";

/** Everything the dispatcher is allowed to touch, so tests can supply all of it. */
export interface DispatcherDeps {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  /** Resolves to an unlisten function, like Tauri's own `listen`. */
  listen(event: string, cb: (payload: unknown) => void): Promise<() => void>;

  getWorkspacePath(): string | null;
  getActiveFilePath(): string | null;
  getSelectedText(): string | null;

  registerCommand(id: string, label: string): void;
  unregisterCommand(id: string): void;
  executeCommand(id: string): Promise<void>;
  /** The plugin that owns a registered command id, if any. */
  commandOwner(id: string): string | undefined;

  setStatusBarItem(item: StatusBarItemSpec): void;
  removeStatusBarItem(id: string): void;
  setToolbarButton(button: ToolbarButtonSpec): void;
  removeToolbarButton(id: string): void;

  setViewTitle(viewId: string, title: string): void;
  setViewBadge(viewId: string, badge: string | number | null): void;

  showNotification(message: string, type: "info" | "warning" | "error"): void;
  log(level: "info" | "warn" | "error", message: string): void;

  /** Deliver a subscription event back to the frame. */
  emitToFrame(subscription: number, payload: unknown): void;
}

export interface StatusBarItemSpec {
  id: string;
  text: string;
  tooltip?: string;
  icon?: PluginIcon;
  alignment: "left" | "right";
}

export interface ToolbarButtonSpec {
  id: string;
  label: string;
  icon: PluginIcon;
  enabled: boolean;
  visible: boolean;
}

export interface DispatcherOptions {
  pluginId: string;
  granted: readonly PluginPermission[];
  role: FrameRole;
  /** Set for a view frame; the view it renders. */
  viewId?: string;
  deps: DispatcherDeps;
}

/**
 * Caps on host chrome a plugin can occupy.
 *
 * Not a memory concern — a plugin should not be able to push the git branch indicator
 * off the status bar, or bury the toolbar. Enforced here rather than in the renderer so
 * it holds no matter which UI path renders the item.
 */
const MAX_STATUS_ITEMS = 4;
const MAX_TOOLBAR_BUTTONS = 4;
const MAX_COMMANDS = 32;
const MAX_SUBSCRIPTIONS = 32;
const MAX_TEXT = 64;
const MAX_LABEL = 80;
const MAX_LOG = 4000;

/** A method invoked with the wrong shape. Serialized as `invalid-params`. */
class InvalidParams extends Error {
  readonly code = "invalid-params";
  constructor(message: string) {
    super(message);
    this.name = "InvalidParams";
  }
}

/** A method only one frame role may call. */
class WrongRole extends Error {
  readonly code = "wrong-role";
  constructor(method: string, role: FrameRole) {
    super(`"${method}" is not available to a ${role} frame`);
    this.name = "WrongRole";
  }
}

class UnknownMethod extends Error {
  readonly code = "unknown-method";
  constructor(method: string) {
    super(`Unknown method "${method}"`);
    this.name = "UnknownMethod";
  }
}

class Disposed extends Error {
  readonly code = "disposed";
  constructor() {
    super("The plugin has been unloaded");
    this.name = "Disposed";
  }
}

function params(req: RpcRequest): Record<string, unknown> {
  const p: unknown = req.params;
  if (p === undefined) return {};
  if (typeof p !== "object" || p === null || Array.isArray(p)) {
    throw new InvalidParams(`"${req.method}" expects an object of parameters`);
  }
  return p as Record<string, unknown>;
}

function requireString(p: Record<string, unknown>, key: string, max = 512): string {
  const v = p[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new InvalidParams(`"${key}" must be a non-empty string`);
  }
  if (v.length > max) throw new InvalidParams(`"${key}" must be at most ${max} characters`);
  return v;
}

function optionalString(p: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new InvalidParams(`"${key}" must be a string`);
  if (v.length > max) throw new InvalidParams(`"${key}" must be at most ${max} characters`);
  return v;
}

function requireIcon(p: Record<string, unknown>, key: string): PluginIcon {
  const v = p[key];
  if (typeof v !== "string" || !(PLUGIN_ICONS as readonly string[]).includes(v)) {
    // An arbitrary icon string reaching an <img src> is an exfiltration channel and
    // reaching inline SVG is script injection, so the set is closed.
    throw new InvalidParams(`"${key}" must be one of: ${PLUGIN_ICONS.join(", ")}`);
  }
  return v as PluginIcon;
}

function optionalIcon(p: Record<string, unknown>, key: string): PluginIcon | undefined {
  return p[key] === undefined || p[key] === null ? undefined : requireIcon(p, key);
}

function invokeArgs(p: Record<string, unknown>): Record<string, unknown> | undefined {
  const v = p.args;
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new InvalidParams(`"args" must be an object`);
  }
  return v as Record<string, unknown>;
}

export interface HostDispatcher {
  handle(req: RpcRequest): Promise<RpcResponse>;
  /** Drop every capability without tearing the frame down. */
  revoke(): void;
  /** Release subscriptions and registrations. */
  dispose(): Promise<void>;
}

export function createHostDispatcher(opts: DispatcherOptions): HostDispatcher {
  const { pluginId, role, viewId, deps } = opts;

  // Mutable, so `revoke()` can strip a running plugin's capabilities without waiting
  // for it to cooperate. Every gate reads this at call time.
  let granted: readonly PluginPermission[] = [...opts.granted];
  let disposed = false;

  const subscriptions = new Map<number, () => void>();
  const commands = new Set<string>();
  const statusItems = new Set<string>();
  const toolbarButtons = new Set<string>();
  let nextSubscription = 1;

  /** Gate for reads that never reach a Tauri command. */
  const require = (permission: PluginPermission, surface: string) => {
    if (!granted.includes(permission)) {
      throw new PluginPermissionError(pluginId, surface, permission);
    }
  };

  const backgroundOnly = (method: string) => {
    // Only the background frame registers contributions. A plugin's bundle runs in
    // every view frame too, so without this a two-panel plugin would register its
    // commands three times and the last teardown would remove them for all of them.
    if (role !== "background") throw new WrongRole(method, role);
  };

  const viewOnly = (method: string): string => {
    if (role !== "view" || !viewId) throw new WrongRole(method, role);
    return viewId;
  };

  /** Qualified id for anything the plugin names. */
  const qualify = (id: string) => `${pluginId}.${id}`;

  async function route(req: RpcRequest): Promise<unknown> {
    if (disposed) throw new Disposed();
    const p = params(req);

    switch (req.method) {
      // ── IPC ────────────────────────────────────────────────────────────
      case "ipc.invoke": {
        const command = requireString(p, "command");
        assertCommandAllowed(pluginId, command, granted);
        return deps.invoke(command, invokeArgs(p));
      }

      case "ipc.subscribe": {
        const event = requireString(p, "event");
        assertEventAllowed(pluginId, event, granted);
        return subscribe(event);
      }

      case "workspace.subscribeFileChanges": {
        // Same channel as ipc.subscribe("fs-changed"), gated identically. It exists
        // as its own method only so the SDK can offer a nicer signature.
        assertEventAllowed(pluginId, "fs-changed", granted);
        return subscribe("fs-changed");
      }

      case "ipc.unsubscribe": {
        const id = p.subscription;
        if (typeof id !== "number") throw new InvalidParams(`"subscription" must be a number`);
        subscriptions.get(id)?.();
        subscriptions.delete(id);
        return null;
      }

      // ── Workspace and editor ───────────────────────────────────────────
      case "workspace.getPath":
        require("workspace:read", "workspace.getPath()");
        return deps.getWorkspacePath();

      case "workspace.readFile": {
        const path = requireString(p, "path", 4096);
        assertCommandAllowed(pluginId, "fs_read_file", granted);
        return deps.invoke("fs_read_file", { path });
      }

      case "workspace.writeFile": {
        const path = requireString(p, "path", 4096);
        const content = p.content;
        if (typeof content !== "string") throw new InvalidParams(`"content" must be a string`);
        assertCommandAllowed(pluginId, "fs_write_file", granted);
        return deps.invoke("fs_write_file", { path, content });
      }

      case "editor.getActiveFilePath":
        require("workspace:read", "editor.getActiveFilePath()");
        return deps.getActiveFilePath();

      case "editor.getSelectedText":
        // File content, arriving by a different door than fs_read_file.
        require("workspace:read", "editor.getSelectedText()");
        return deps.getSelectedText();

      // ── Commands ───────────────────────────────────────────────────────
      case "commands.register": {
        backgroundOnly(req.method);
        const id = requireString(p, "id", 120);
        const label = requireString(p, "label", MAX_LABEL);
        if (commands.size >= MAX_COMMANDS && !commands.has(qualify(id))) {
          throw new InvalidParams(`a plugin may register at most ${MAX_COMMANDS} commands`);
        }
        commands.add(qualify(id));
        deps.registerCommand(qualify(id), label);
        return qualify(id);
      }

      case "commands.unregister": {
        backgroundOnly(req.method);
        const id = qualify(requireString(p, "id", 120));
        commands.delete(id);
        deps.unregisterCommand(id);
        return null;
      }

      case "commands.execute": {
        const id = requireString(p, "id", 200);
        // julIDE's own commands live in the same registry, and their handlers call
        // `invoke` directly with no permission check. Without both tests below, a
        // plugin declaring nothing could run `julia.run`.
        //
        // The prefix test refuses a probe for a built-in id before it can learn
        // whether that id exists; the ownership test is the real boundary, and it
        // closes the case where one plugin's name is a dotted prefix of another's.
        const owner = deps.commandOwner(id);
        if (!id.startsWith(`${pluginId}.`) || (owner !== undefined && owner !== pluginId)) {
          throw new PluginPermissionError(pluginId, `commands.execute(${id})`, null);
        }
        await deps.executeCommand(id);
        return null;
      }

      // ── Host chrome ────────────────────────────────────────────────────
      case "ui.setStatusBarItem": {
        backgroundOnly(req.method);
        const id = qualify(requireString(p, "id", 120));
        if (statusItems.size >= MAX_STATUS_ITEMS && !statusItems.has(id)) {
          throw new InvalidParams(`a plugin may show at most ${MAX_STATUS_ITEMS} status bar items`);
        }
        const alignment = p.alignment === "right" ? "right" : "left";
        statusItems.add(id);
        deps.setStatusBarItem({
          id,
          text: requireString(p, "text", MAX_TEXT),
          tooltip: optionalString(p, "tooltip", 200),
          icon: optionalIcon(p, "icon"),
          alignment,
        });
        return id;
      }

      case "ui.removeStatusBarItem": {
        backgroundOnly(req.method);
        const id = qualify(requireString(p, "id", 120));
        statusItems.delete(id);
        deps.removeStatusBarItem(id);
        return null;
      }

      case "ui.setToolbarButton": {
        backgroundOnly(req.method);
        const id = qualify(requireString(p, "id", 120));
        if (toolbarButtons.size >= MAX_TOOLBAR_BUTTONS && !toolbarButtons.has(id)) {
          throw new InvalidParams(
            `a plugin may show at most ${MAX_TOOLBAR_BUTTONS} toolbar buttons`,
          );
        }
        toolbarButtons.add(id);
        deps.setToolbarButton({
          id,
          label: requireString(p, "label", MAX_LABEL),
          icon: requireIcon(p, "icon"),
          enabled: p.enabled !== false,
          visible: p.visible !== false,
        });
        return id;
      }

      case "ui.removeToolbarButton": {
        backgroundOnly(req.method);
        const id = qualify(requireString(p, "id", 120));
        toolbarButtons.delete(id);
        deps.removeToolbarButton(id);
        return null;
      }

      case "ui.showNotification": {
        const type = p.type;
        deps.showNotification(
          requireString(p, "message", 500),
          type === "warning" || type === "error" ? type : "info",
        );
        return null;
      }

      // ── The plugin's own view ──────────────────────────────────────────
      case "view.setTitle": {
        const id = viewOnly(req.method);
        deps.setViewTitle(id, requireString(p, "title", MAX_TEXT));
        return null;
      }

      case "view.setBadge": {
        const id = viewOnly(req.method);
        const badge = p.badge;
        if (badge !== null && typeof badge !== "string" && typeof badge !== "number") {
          throw new InvalidParams(`"badge" must be a string, a number, or null`);
        }
        deps.setViewBadge(id, typeof badge === "string" ? badge.slice(0, 12) : badge);
        return null;
      }

      // ── Logging ────────────────────────────────────────────────────────
      case "log.write": {
        const level = p.level;
        deps.log(
          level === "warn" || level === "error" ? level : "info",
          requireString(p, "message", MAX_LOG),
        );
        return null;
      }

      default:
        throw new UnknownMethod(req.method);
    }
  }

  async function subscribe(event: string): Promise<number> {
    if (subscriptions.size >= MAX_SUBSCRIPTIONS) {
      throw new InvalidParams(`a plugin may hold at most ${MAX_SUBSCRIPTIONS} subscriptions`);
    }
    const id = nextSubscription++;
    // Reserve the slot before awaiting, so a burst of subscribe calls cannot race
    // past the cap while the first listener is still being set up.
    subscriptions.set(id, () => {});
    try {
      const unlisten = await deps.listen(event, (payload) => {
        // The host owns the real listener, so a torn-down frame cannot leak one and
        // revocation stops delivery without the plugin's cooperation.
        if (!disposed && subscriptions.has(id)) deps.emitToFrame(id, payload);
      });
      if (disposed || !subscriptions.has(id)) {
        unlisten();
        throw new Disposed();
      }
      subscriptions.set(id, unlisten);
      return id;
    } catch (e) {
      subscriptions.delete(id);
      throw e;
    }
  }

  return {
    async handle(req: RpcRequest): Promise<RpcResponse> {
      try {
        const value = await route(req);
        return { kind: "res", id: req.id, ok: true, value };
      } catch (e) {
        return { kind: "res", id: req.id, ok: false, error: serializeError(e) };
      }
    },

    revoke() {
      granted = [];
    },

    async dispose() {
      disposed = true;
      for (const unlisten of subscriptions.values()) {
        try {
          unlisten();
        } catch {
          /* a listener that never attached */
        }
      }
      subscriptions.clear();
      for (const id of commands) deps.unregisterCommand(id);
      for (const id of statusItems) deps.removeStatusBarItem(id);
      for (const id of toolbarButtons) deps.removeToolbarButton(id);
      commands.clear();
      statusItems.clear();
      toolbarButtons.clear();
    },
  };
}
