/**
 * Tauri IPC mock utilities for testing.
 *
 * Provides a registry-based mock for `invoke()` and `listen()` so tests
 * can register expected command responses without hitting the real Tauri backend.
 */

/** Registry mapping Tauri command names to mock handler functions. */
export const invokeHandlers = new Map<string, (...args: any[]) => any>();

/**
 * Mock implementation of `@tauri-apps/api/core` `invoke()`.
 * Looks up the command in `invokeHandlers`. If found, calls the handler with args.
 * If not found, resolves with `undefined` (silent no-op).
 */
export async function mockInvoke(command: string, args?: Record<string, unknown>): Promise<any> {
  const handler = invokeHandlers.get(command);
  if (handler) return handler(args);
  return undefined;
}

/** Listeners registered via mockListen */
export const eventListeners = new Map<string, Set<(event: any) => void>>();

/**
 * Mock implementation of `@tauri-apps/api/event` `listen()`.
 * Returns an unlisten function.
 */
export async function mockListen(
  event: string,
  callback: (event: any) => void,
): Promise<() => void> {
  if (!eventListeners.has(event)) {
    eventListeners.set(event, new Set());
  }
  eventListeners.get(event)!.add(callback);
  return () => {
    eventListeners.get(event)?.delete(callback);
  };
}

/** Emit a mock event to all registered listeners. */
export function emitMockEvent(event: string, payload: unknown): void {
  const listeners = eventListeners.get(event);
  if (listeners) {
    for (const cb of listeners) {
      cb({ payload });
    }
  }
}

/** Clear all registered handlers and listeners between tests. */
export function resetTauriMocks(): void {
  invokeHandlers.clear();
  eventListeners.clear();
}
