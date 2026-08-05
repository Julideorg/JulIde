/**
 * Mock for @tauri-apps/api/event — used by Storybook via Vite alias.
 */

export async function listen(_event: string, _callback: (event: any) => void): Promise<() => void> {
  return () => {};
}

export async function emit(_event: string, _payload?: unknown): Promise<void> {}

export async function once(_event: string, _callback: (event: any) => void): Promise<() => void> {
  return () => {};
}
