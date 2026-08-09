/**
 * Frame lifecycle and the handshake that hands a plugin its capabilities.
 *
 * This is the impure half of the sandbox — it owns iframes, `window` listeners and
 * `MessagePort`s. The decisions live in `dispatcher.ts`; what happens here is getting a
 * frame created with nothing, proving the message that comes back is really from it, and
 * only then handing over the port.
 *
 * The ordering is the point. A frame exists before its bundle runs, and the bundle's
 * top-level code runs before `activate` — that is module semantics and cannot be changed.
 * What can be changed is what that code has access to: an opaque origin, no
 * `__TAURI_INTERNALS__`, no parent DOM, `connect-src` limited to declared origins, and no
 * port until the host has decided to give it one.
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import { PROTOCOL_VERSION, isEnvelope, isReadyPing, isRpcRequest, type RpcEvent } from "./protocol";
import { createHostDispatcher, type DispatcherDeps, type FrameRole } from "./dispatcher";
import type { PluginPermission } from "../pluginPermissions";

export interface FrameSpec {
  pluginId: string;
  role: FrameRole;
  /** Required for a view frame. */
  viewId?: string;
  granted: readonly PluginPermission[];
  /** Where the frame is mounted. Background frames get an off-screen host. */
  container: HTMLElement;
  deps: DispatcherDeps;
  /** Reported when the frame fails to hand back a valid ping in time. */
  onError?: (message: string) => void;
}

export interface FrameHandle {
  readonly frameId: string;
  readonly pluginId: string;
  readonly role: FrameRole;
  readonly viewId?: string;
  /** Resolves once the frame has been handed its port. Rejects on timeout. */
  ready: Promise<void>;
  /** Ask the frame to run one of its own commands. */
  execute(commandId: string): Promise<void>;
  /** Push a host event into the frame. */
  send(event: RpcEvent): void;
  /** Strip capabilities without tearing the frame down. */
  revoke(): void;
  destroy(): Promise<void>;
}

/** A frame that never completes the handshake is torn down rather than left hanging. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** How long the host waits for a plugin to run one of its commands. */
const COMMAND_TIMEOUT_MS = 5_000;
/**
 * In-flight frame→host requests allowed at once.
 *
 * A runaway loop in a plugin would otherwise wedge the main thread through the message
 * queue, which looks like the IDE hanging rather than like a misbehaving plugin.
 */
const MAX_IN_FLIGHT = 128;

function randomFrameId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The URL for a frame.
 *
 * Built with Tauri's own helper because the scheme is served as
 * `http://julide-plugin.localhost` on Windows and Android and as `julide-plugin://` on
 * everything else, and that difference is not something to re-derive here. It
 * percent-encodes the path, which the Rust handler decodes before routing.
 */
function frameUrl(pluginId: string, role: FrameRole, viewId: string | undefined, frameId: string) {
  const path = role === "view" ? `${pluginId}/view/${viewId}` : `${pluginId}/background`;
  return `${convertFileSrc(path, "julide-plugin")}?frame=${frameId}`;
}

export function createPluginFrame(spec: FrameSpec): FrameHandle {
  const frameId = randomFrameId();
  const dispatcher = createHostDispatcher({
    pluginId: spec.pluginId,
    granted: spec.granted,
    role: spec.role,
    viewId: spec.viewId,
    deps: {
      ...spec.deps,
      emitToFrame: (subscription, payload) => {
        post({ kind: "evt", name: "subscription", subscription, payload });
      },
    },
  });

  const iframe = document.createElement("iframe");
  // No `allow-same-origin`. That omission is the whole boundary: it is what gives the
  // document an opaque origin, which is what removes __TAURI_INTERNALS__, the parent
  // DOM, and storage access. Adding it back would silently undo the sandbox.
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("title", `${spec.pluginId} (${spec.role})`);
  iframe.className = "plugin-frame";
  iframe.src = frameUrl(spec.pluginId, spec.role, spec.viewId, frameId);

  let port: MessagePort | null = null;
  let destroyed = false;
  let inFlight = 0;
  let nextHostRequestId = 1;
  const hostRequests = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();

  let resolveReady: () => void;
  let rejectReady: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  // Nothing awaits `ready` on the failure path in every caller, and an unhandled
  // rejection would surface as a global error rather than as the plugin's problem.
  ready.catch(() => {});

  const handshakeTimer = setTimeout(() => {
    if (port || destroyed) return;
    const message =
      `Plugin "${spec.pluginId}" did not start within ${HANDSHAKE_TIMEOUT_MS / 1000}s. ` +
      `Its entry file may have thrown before calling into the julIDE SDK.`;
    spec.onError?.(message);
    rejectReady(new Error(message));
    void destroy();
  }, HANDSHAKE_TIMEOUT_MS);

  function post(
    envelope: RpcEvent | { kind: "res"; id: number; ok: boolean; value?: unknown; error?: unknown },
  ) {
    port?.postMessage(envelope);
  }

  /**
   * The one moment a `window`-level message is trusted.
   *
   * Three independent checks, because `targetOrigin` cannot be used: an opaque origin
   * has no nameable origin, so the reply below must go to `"*"`.
   *
   *  1. `event.source` identity — a different frame is a different `contentWindow`, so
   *     no plugin can impersonate another even knowing its frame id.
   *  2. the 128-bit frame id, which lives only in a URL the frame cannot read out.
   *  3. the protocol version, so a mismatch is refused rather than half-understood.
   *
   * After the port is transferred this listener is removed, and every later message is
   * authenticated by possession of the port rather than by inspection.
   */
  function onWindowMessage(e: MessageEvent) {
    if (destroyed || port) return;
    if (e.source !== iframe.contentWindow) return;
    if (!isReadyPing(e.data)) return;
    if (e.data.frameId !== frameId) {
      // Someone in the page is guessing. Worth saying so rather than ignoring.
      spec.onError?.(`A plugin frame announced an unexpected id. Ignoring it. (${spec.pluginId})`);
      return;
    }
    if (e.data.protocolVersion !== PROTOCOL_VERSION) {
      const message =
        `Plugin "${spec.pluginId}" speaks plugin protocol v${e.data.protocolVersion}; ` +
        `this julIDE speaks v${PROTOCOL_VERSION}.`;
      spec.onError?.(message);
      rejectReady(new Error(message));
      void destroy();
      return;
    }

    window.removeEventListener("message", onWindowMessage);
    clearTimeout(handshakeTimer);

    const channel = new MessageChannel();
    port = channel.port1;
    port.onmessage = onPortMessage;
    port.start();

    iframe.contentWindow?.postMessage(
      {
        julidePluginInit: true,
        protocolVersion: PROTOCOL_VERSION,
        pluginId: spec.pluginId,
        role: spec.role,
        viewId: spec.viewId,
      },
      "*",
      [channel.port2],
    );
    resolveReady();
  }

  async function onPortMessage(e: MessageEvent) {
    if (destroyed) return;
    const data: unknown = e.data;

    // A reply to something the host asked the frame to do.
    if (isEnvelope(data) && data.kind === "res") {
      const pending = hostRequests.get(data.id);
      if (!pending) return;
      hostRequests.delete(data.id);
      if (data.ok) pending.resolve();
      else pending.reject(new Error(data.error?.message ?? "the plugin reported a failure"));
      return;
    }

    if (!isRpcRequest(data)) return;

    if (inFlight >= MAX_IN_FLIGHT) {
      post({
        kind: "res",
        id: data.id,
        ok: false,
        error: {
          code: "internal",
          name: "Error",
          message: `Too many concurrent requests from "${spec.pluginId}".`,
        },
      });
      return;
    }

    inFlight += 1;
    try {
      post(await dispatcher.handle(data));
    } finally {
      inFlight -= 1;
    }
  }

  window.addEventListener("message", onWindowMessage);
  spec.container.appendChild(iframe);

  async function destroy(): Promise<void> {
    if (destroyed) return;
    destroyed = true;
    clearTimeout(handshakeTimer);
    window.removeEventListener("message", onWindowMessage);
    for (const pending of hostRequests.values()) {
      pending.reject(new Error("the plugin was unloaded"));
    }
    hostRequests.clear();
    await dispatcher.dispose();
    // Closing the port is what actually removes the capability: the plugin still holds
    // its end, but there is no longer anything on the other side of it.
    port?.close();
    port = null;
    iframe.remove();
  }

  return {
    frameId,
    pluginId: spec.pluginId,
    role: spec.role,
    viewId: spec.viewId,
    ready,

    execute(commandId: string): Promise<void> {
      if (!port) return Promise.reject(new Error("the plugin is not running"));
      const id = nextHostRequestId++;
      return new Promise<void>((resolve, reject) => {
        hostRequests.set(id, { resolve, reject });
        port!.postMessage({ kind: "req", id, method: "commands.execute", params: { commandId } });
        // A plugin that never answers must not leave a palette entry spinning forever.
        setTimeout(() => {
          if (!hostRequests.delete(id)) return;
          reject(new Error(`"${commandId}" did not finish within ${COMMAND_TIMEOUT_MS / 1000}s`));
        }, COMMAND_TIMEOUT_MS);
      });
    },

    send(event: RpcEvent) {
      post(event);
    },

    revoke() {
      dispatcher.revoke();
    },

    destroy,
  };
}
