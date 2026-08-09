/**
 * Global test setup — preloaded by Bun test runner via bunfig.toml.
 * Mocks all Tauri API modules so tests can run without a Tauri runtime.
 */
import { mock } from "bun:test";
import { mockInvoke, mockListen } from "./tauriMock";

// Mock @tauri-apps/api/core
mock.module("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
  // Used by the plugin sandbox to build `julide-plugin://` frame URLs. The real one
  // percent-encodes the path and picks the platform's scheme form; the shape is all
  // the tests need.
  convertFileSrc: (path: string, protocol = "asset") =>
    `${protocol}://localhost/${encodeURIComponent(path)}`,
}));

// Mock @tauri-apps/api/event
mock.module("@tauri-apps/api/event", () => ({
  listen: mockListen,
  emit: async () => {},
  once: async () => () => {},
}));

// Mock Tauri plugins the frontend actually uses.
//
// The shell, fs, and dialog plugins are intentionally absent: the frontend does
// that work through custom Tauri commands instead, and the corresponding
// permissions are no longer granted in src-tauri/capabilities/default.json. If a
// mock for one of them ever becomes necessary again, the capability has to come
// back too — so make that a deliberate decision rather than a silent one.
mock.module("@tauri-apps/plugin-opener", () => ({
  openUrl: async () => {},
  openPath: async () => {},
  open: async () => {},
}));

mock.module("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: async () => "",
  writeText: async () => {},
}));
