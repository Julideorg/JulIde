/**
 * The wire format between julIDE and a sandboxed plugin frame.
 *
 * A plugin runs in an opaque-origin iframe with no IPC bridge of its own, so every
 * capability it has arrives as a message over a `MessagePort`. This module is the
 * format and nothing else: no DOM, no stores, no `invoke`. That is deliberate — it is
 * the half of the boundary that can be exhaustively tested under `bun test`, which has
 * no browser.
 *
 * Everything crossing this boundary is attacker-controlled. `isEnvelope` is the only
 * thing standing between a hostile frame and the dispatcher, so it validates shape
 * rather than trusting it.
 */

/**
 * Bumped when the shape below changes incompatibly.
 *
 * The host refuses a frame that announces a different version rather than guessing,
 * because a half-understood envelope is worse than a rejected one.
 */
export const PROTOCOL_VERSION = 2;

/** Why a request failed, in a form the plugin can branch on without parsing prose. */
export type PluginErrorCode =
  /** A real permission exists for this, and the plugin was not granted it. */
  | "permission-denied"
  /** No permission can grant this — the command or event is not in the catalog. */
  | "forbidden-target"
  | "unknown-method"
  | "invalid-params"
  /** e.g. a view frame trying to register a command, which only a background frame may do. */
  | "wrong-role"
  | "timeout"
  | "disposed"
  | "internal";

export interface SerializedError {
  code: PluginErrorCode;
  /** Preserved so `err.name === "PluginPermissionError"` still works after the hop. */
  name: string;
  message: string;
  /** The permission that was missing, when there was one. */
  permission?: string | null;
  /** The command or event the plugin was reaching for. */
  target?: string;
}

export interface RpcRequest {
  kind: "req";
  /** Correlation id, unique per sender. The two directions are matched separately, so they never collide. */
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  kind: "res";
  id: number;
  ok: boolean;
  /** Present iff `ok`. Must be structured-cloneable. */
  value?: unknown;
  /** Present iff not `ok`. */
  error?: SerializedError;
}

export interface RpcEvent {
  kind: "evt";
  name: string;
  /** Set when this belongs to a subscription the plugin created. */
  subscription?: number;
  payload?: unknown;
}

export type Envelope = RpcRequest | RpcResponse | RpcEvent;

/** The frame's opening message. Answered with a port, or ignored. */
export interface ReadyPing {
  julidePluginReady: true;
  /** Echoed back from the frame URL. The host compares it against what it generated. */
  frameId: string;
  protocolVersion: number;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  // A structured-cloned plain object has Object.prototype. Anything else — a cloned
  // Map, a Date, or an object carrying an own "__proto__" key — is not what this
  // protocol carries, and refusing it here means nothing downstream has to wonder.
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function has(v: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(v, key);
}

/** Correlation ids must be finite non-negative integers — anything else is a probe. */
function isValidId(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

export function isRpcRequest(v: unknown): v is RpcRequest {
  if (!isPlainRecord(v) || v.kind !== "req") return false;
  return isValidId(v.id) && typeof v.method === "string" && v.method.length > 0;
}

export function isRpcResponse(v: unknown): v is RpcResponse {
  if (!isPlainRecord(v) || v.kind !== "res") return false;
  if (!isValidId(v.id) || typeof v.ok !== "boolean") return false;
  // A failure has to say why. Without this a frame could send `{ok:false}` and the
  // caller would reject with `undefined`.
  if (!v.ok && !isSerializedError(v.error)) return false;
  return true;
}

export function isRpcEvent(v: unknown): v is RpcEvent {
  if (!isPlainRecord(v) || v.kind !== "evt") return false;
  if (typeof v.name !== "string" || v.name.length === 0) return false;
  if (has(v, "subscription") && !isValidId(v.subscription)) return false;
  return true;
}

export function isEnvelope(v: unknown): v is Envelope {
  return isRpcRequest(v) || isRpcResponse(v) || isRpcEvent(v);
}

export function isSerializedError(v: unknown): v is SerializedError {
  return (
    isPlainRecord(v) &&
    typeof v.code === "string" &&
    typeof v.name === "string" &&
    typeof v.message === "string"
  );
}

export function isReadyPing(v: unknown): v is ReadyPing {
  return (
    isPlainRecord(v) &&
    v.julidePluginReady === true &&
    typeof v.frameId === "string" &&
    v.frameId.length > 0 &&
    typeof v.protocolVersion === "number"
  );
}

/**
 * An error that survived the hop from the host.
 *
 * The `name` is restored from the wire so `err.name === "PluginPermissionError"` keeps
 * working, but `code` is what plugin authors should branch on — it is a closed set,
 * where the name is not.
 */
export class PluginRpcError extends Error {
  readonly code: PluginErrorCode;
  readonly permission: string | null;
  readonly target: string | undefined;

  constructor(serialized: SerializedError) {
    super(serialized.message);
    this.name = serialized.name;
    this.code = serialized.code;
    this.permission = serialized.permission ?? null;
    this.target = serialized.target;
  }
}

/**
 * Flatten an error for the wire.
 *
 * Errors are not structured-cloneable in a useful way — the clone loses the subclass
 * and every own field — so the parts worth keeping are copied out explicitly. The
 * message is passed through verbatim: `PluginPermissionError` already writes the one
 * that tells an author which permission to add and where to re-approve it, and
 * rewording it here would mean two versions of the same sentence.
 */
export function serializeError(
  e: unknown,
  fallback: PluginErrorCode = "internal",
): SerializedError {
  if (e instanceof Error) {
    const withFields = e as Error & {
      code?: unknown;
      required?: unknown;
      command?: unknown;
      permission?: unknown;
      target?: unknown;
    };
    const permission =
      typeof withFields.required === "string"
        ? withFields.required
        : typeof withFields.permission === "string"
          ? withFields.permission
          : null;
    const target =
      typeof withFields.command === "string"
        ? withFields.command
        : typeof withFields.target === "string"
          ? withFields.target
          : undefined;

    let code = fallback;
    if (typeof withFields.code === "string" && isErrorCode(withFields.code)) {
      code = withFields.code;
    } else if (e.name === "PluginPermissionError") {
      // A denial with no named permission means the target is not in the catalog at
      // all — no grant could ever allow it, which is a different fact from "you did
      // not ask for this one" and a plugin should be able to tell them apart.
      code = permission ? "permission-denied" : "forbidden-target";
    }

    return { code, name: e.name, message: e.message, permission, target };
  }
  return { code: fallback, name: "Error", message: String(e), permission: null };
}

const ERROR_CODES = new Set<string>([
  "permission-denied",
  "forbidden-target",
  "unknown-method",
  "invalid-params",
  "wrong-role",
  "timeout",
  "disposed",
  "internal",
]);

function isErrorCode(v: string): v is PluginErrorCode {
  return ERROR_CODES.has(v);
}

export function deserializeError(s: SerializedError): PluginRpcError {
  return new PluginRpcError(s);
}
