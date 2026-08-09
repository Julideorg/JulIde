/**
 * Runs inside a sandboxed plugin frame, before the plugin's own code.
 *
 * Built to `src-tauri/assets/plugin-bootstrap.js` by `scripts/build-plugin-bootstrap.ts`
 * and inlined into every frame document, because a `<script src>` load from an opaque
 * origin is a CORS fetch and wry does not register custom schemes as CORS-enabled on
 * WebKitGTK.
 *
 * Inlined as a **classic** script, not a module: an inline `<script type="module">` in
 * this frame does not execute on WebKitGTK — no code runs and no error is raised — so a
 * plugin loaded that way just looks inert. A plugin's entry file is therefore also a
 * classic script, and hands its exports over by assigning `window.julide`.
 *
 * It is deliberately small and dependency-free. Everything it can do, a plugin could
 * have done itself — the security properties come from the frame, not from this file.
 *
 * The frame's own code runs *after* this, and receives `ctx` only once the host has sent
 * a port. Top-level plugin code therefore runs with an opaque origin, no IPC bridge, and
 * `connect-src` limited to whatever the manifest declared — which is what makes the
 * "top-level code runs before anything checks it" problem stop mattering.
 */

declare global {
  interface Window {
    __JULIDE_FRAME__: {
      pluginId: string;
      role: "background" | "view";
      viewId: string;
      frameId: string | null;
    };
    julide?: unknown;
  }
}

const PROTOCOL_VERSION = 2;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

class PluginPermissionError extends Error {
  readonly code: string;
  readonly permission: string | null;
  constructor(s: { code: string; name: string; message: string; permission?: string | null }) {
    super(s.message);
    this.name = s.name;
    this.code = s.code;
    this.permission = s.permission ?? null;
  }
}

function boot() {
  const frame = window.__JULIDE_FRAME__;

  // A plugin failing silently inside a frame is worse than one failing loudly: no
  // ErrorBoundary can see across the boundary, so the SDK reports it itself. Installed
  // first, because the most useful failure to catch — the plugin's module throwing while
  // it is being evaluated — happens before the host has handed over a port, and there is
  // nowhere to send it yet.
  const earlyErrors: string[] = [];
  let reportError = (message: string) => {
    earlyErrors.push(message);
  };
  window.addEventListener("error", (ev) =>
    reportError(
      ev.error instanceof Error ? `${ev.error.name}: ${ev.error.message}` : String(ev.message),
    ),
  );
  window.addEventListener("unhandledrejection", (ev) =>
    reportError(`Unhandled rejection: ${String(ev.reason)}`),
  );

  let port: MessagePort | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const subscriptions = new Map<number, (payload: unknown) => void>();
  const commands = new Map<string, () => void | Promise<void>>();
  const eventTargets: Record<string, Set<(payload: unknown) => void>> = {};

  function call(method: string, params?: unknown): Promise<unknown> {
    if (!port) return Promise.reject(new Error("julIDE: the plugin host has not connected"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      port!.postMessage({ kind: "req", id, method, params });
    });
  }

  function onPortMessage(e: MessageEvent) {
    const data = e.data as
      | { kind: "res"; id: number; ok: boolean; value?: unknown; error?: never }
      | { kind: "evt"; name: string; subscription?: number; payload?: unknown }
      | { kind: "req"; id: number; method: string; params?: { commandId?: string } };
    if (!data || typeof data !== "object") return;

    if (data.kind === "res") {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if (data.ok) p.resolve(data.value);
      else p.reject(new PluginPermissionError(data.error!));
      return;
    }

    if (data.kind === "evt") {
      if (data.name === "subscription" && typeof data.subscription === "number") {
        subscriptions.get(data.subscription)?.(data.payload);
        return;
      }
      for (const cb of eventTargets[data.name] ?? []) cb(data.payload);
      return;
    }

    if (data.kind === "req" && data.method === "commands.execute") {
      const handler = commands.get(String(data.params?.commandId ?? ""));
      void Promise.resolve()
        .then(() => handler?.())
        .then(
          () => port?.postMessage({ kind: "res", id: data.id, ok: true }),
          (e: unknown) =>
            port?.postMessage({
              kind: "res",
              id: data.id,
              ok: false,
              error: {
                code: "internal",
                name: "Error",
                message: e instanceof Error ? e.message : String(e),
              },
            }),
        );
    }
  }

  function disposable(dispose: () => void) {
    return { dispose };
  }

  async function subscribe(method: string, params: unknown, cb: (payload: unknown) => void) {
    const id = (await call(method, params)) as number;
    subscriptions.set(id, cb);
    return disposable(() => {
      subscriptions.delete(id);
      void call("ipc.unsubscribe", { subscription: id });
    });
  }

  function on(name: string, cb: (payload: unknown) => void) {
    (eventTargets[name] ??= new Set()).add(cb);
    return disposable(() => eventTargets[name]?.delete(cb));
  }

  const ctx = {
    pluginId: frame.pluginId,
    apiVersion: PROTOCOL_VERSION,
    view:
      frame.role === "view"
        ? {
            id: frame.viewId,
            setTitle: (title: string) => call("view.setTitle", { title }).then(() => {}),
            setBadge: (badge: string | number | null) =>
              call("view.setBadge", { badge }).then(() => {}),
            onVisibilityChange: (cb: (visible: boolean) => void) =>
              on("view.visibility", (p) => cb((p as { visible: boolean }).visible)),
            onResize: (cb: (size: { width: number; height: number }) => void) =>
              on("view.resize", (p) => cb(p as { width: number; height: number })),
          }
        : undefined,

    commands: {
      async register(id: string, label: string, handler: () => void | Promise<void>) {
        const fullId = (await call("commands.register", { id, label })) as string;
        commands.set(fullId, handler);
        return disposable(() => {
          commands.delete(fullId);
          void call("commands.unregister", { id });
        });
      },
      execute: (id: string) => call("commands.execute", { id }).then(() => {}),
    },

    ui: {
      setStatusBarItem: (item: Record<string, unknown>) =>
        call("ui.setStatusBarItem", item).then((id) =>
          disposable(() => void call("ui.removeStatusBarItem", { id })),
        ),
      setToolbarButton: (b: Record<string, unknown>) =>
        call("ui.setToolbarButton", b).then((id) =>
          disposable(() => void call("ui.removeToolbarButton", { id })),
        ),
      showNotification: (message: string, type: "info" | "warning" | "error" = "info") =>
        void call("ui.showNotification", { message, type }),
    },

    workspace: {
      getPath: () => call("workspace.getPath") as Promise<string | null>,
      readFile: (path: string) => call("workspace.readFile", { path }) as Promise<string>,
      writeFile: (path: string, content: string) =>
        call("workspace.writeFile", { path, content }).then(() => {}),
      onDidChangeFiles: (cb: (paths: string[]) => void) =>
        subscribe("workspace.subscribeFileChanges", undefined, (p) =>
          cb([(p as { path: string }).path]),
        ),
    },

    editor: {
      getActiveFilePath: () => call("editor.getActiveFilePath") as Promise<string | null>,
      getSelectedText: () => call("editor.getSelectedText") as Promise<string | null>,
    },

    ipc: {
      invoke: (command: string, args?: Record<string, unknown>) =>
        call("ipc.invoke", { command, args }),
      listen: (event: string, cb: (payload: unknown) => void) =>
        subscribe("ipc.subscribe", { event }, cb),
    },

    log: {
      info: (message: string) => void call("log.write", { level: "info", message }),
      warn: (message: string) => void call("log.write", { level: "warn", message }),
      error: (message: string) => void call("log.write", { level: "error", message }),
    },
  };

  /**
   * Wait for the host's port, then hand the plugin its context.
   *
   * The plugin's module has already been evaluated by the time this resolves — that is
   * unavoidable — but it had nothing to reach until now.
   */
  window.addEventListener("message", function onInit(e: MessageEvent) {
    const d = e.data as { julidePluginInit?: boolean; protocolVersion?: number };
    if (!d?.julidePluginInit || e.source !== window.parent) return;
    if (d.protocolVersion !== PROTOCOL_VERSION) return;
    const transferred = e.ports[0];
    if (!transferred) return;

    window.removeEventListener("message", onInit);
    port = transferred;
    port.onmessage = onPortMessage;
    port.start();

    // Anything captured before the port existed is only reportable now.
    for (const message of earlyErrors) ctx.log.error(message);
    earlyErrors.length = 0;
    reportError = (message: string) => ctx.log.error(message);

    const mod = window.julide as
      { activate?: (c: unknown) => unknown; renderView?: (c: unknown) => unknown } | undefined;
    const entry = frame.role === "view" ? mod?.renderView : mod?.activate;
    if (typeof entry !== "function") {
      // Naming what the plugin *did* set turns "it does not work" into something an
      // author can act on — usually a typo, or an assignment that never ran.
      const found = mod ? Object.keys(mod).join(", ") || "nothing" : "nothing";
      ctx.log.error(
        frame.role === "view"
          ? `Plugin does not export renderView(), so its "${frame.viewId}" view is empty. It set: ${found}.`
          : `Plugin does not export activate(). It set: ${found}.`,
      );
      return;
    }
    void Promise.resolve()
      .then(() => entry(ctx))
      .catch((e: unknown) => ctx.log.error(e instanceof Error ? e.message : String(e)));
  });

  // The plugin bundle assigns its exports here; the host cannot import from an opaque
  // origin, so this global is the handoff.
  window.julide = window.julide ?? {};

  // Measured from inside the frame, where the answers are actually knowable. The host
  // refuses to hand over a port unless all four hold — see IsolationReport for why this
  // is a canary for platform differences rather than a defence against plugins.
  let storageBlocked = false;
  try {
    localStorage.setItem("__julide_probe", "1");
    localStorage.removeItem("__julide_probe");
  } catch {
    storageBlocked = true;
  }

  window.parent.postMessage(
    {
      julidePluginReady: true,
      frameId: frame.frameId,
      protocolVersion: PROTOCOL_VERSION,
      isolation: {
        tauriInternals: typeof (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__,
        opaqueOrigin: window.origin === "null",
        storageBlocked,
        // The un-nonced script in the document sets this. If the CSP header was applied
        // it never ran, so the flag is still undefined.
        cspApplied: (window as unknown as Record<string, unknown>).__JULIDE_CSP_BYPASSED__ !== true,
      },
    },
    "*",
  );
}

boot();

export {};
