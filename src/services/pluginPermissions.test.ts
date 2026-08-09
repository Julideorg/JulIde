import { describe, expect, test } from "bun:test";
import {
  ALL_PERMISSIONS,
  COMMAND_PERMISSIONS,
  EVENT_PERMISSIONS,
  PERMISSION_CATALOG,
  PluginPermissionError,
  assertCommandAllowed,
  assertEventAllowed,
  parsePermissions,
  unknownPermissions,
} from "./pluginPermissions";

describe("permission catalog", () => {
  test("every permission in the command map exists in the catalog", () => {
    for (const [command, permission] of Object.entries(COMMAND_PERMISSIONS)) {
      expect(PERMISSION_CATALOG[permission], `${command} -> ${permission}`).toBeDefined();
    }
  });

  test("every catalogued permission is reachable by at least one command", () => {
    const used = new Set(Object.values(COMMAND_PERMISSIONS));
    for (const permission of ALL_PERMISSIONS) {
      expect(used.has(permission), `${permission} maps to no command`).toBe(true);
    }
  });

  test("destructive and credential permissions are marked high risk", () => {
    for (const p of [
      "workspace:write",
      "julia:run",
      "julia:configure",
      "terminal",
      "git:write",
      "git:credentials",
      "containers",
    ] as const) {
      expect(PERMISSION_CATALOG[p].risk, p).toBe("high");
    }
  });
});

describe("assertCommandAllowed", () => {
  test("allows a command covered by a granted permission", () => {
    expect(() => assertCommandAllowed("p", "fs_read_file", ["workspace:read"])).not.toThrow();
  });

  test("rejects a command whose permission was not granted", () => {
    expect(() => assertCommandAllowed("p", "fs_write_file", ["workspace:read"])).toThrow(
      PluginPermissionError,
    );
  });

  test("rejects everything when nothing was granted", () => {
    expect(() => assertCommandAllowed("p", "fs_read_file", [])).toThrow(PluginPermissionError);
  });

  test("read access does not imply write access", () => {
    const granted = ["workspace:read", "git:read"] as const;
    expect(() => assertCommandAllowed("p", "fs_delete_entry", granted)).toThrow();
    expect(() => assertCommandAllowed("p", "git_push", granted)).toThrow();
    expect(() => assertCommandAllowed("p", "git_commit", granted)).toThrow();
  });

  test("fails closed on commands that are not in the map", () => {
    // A newly added Tauri command must not become reachable by default.
    expect(() => assertCommandAllowed("p", "some_future_command", ALL_PERMISSIONS)).toThrow(
      /may never call/,
    );
  });

  test("plugin-management commands are never reachable, even with everything granted", () => {
    for (const cmd of [
      "plugin_scan",
      "plugin_get_dir",
      "plugin_grants_load",
      "plugin_grants_save",
    ]) {
      expect(() => assertCommandAllowed("p", cmd, ALL_PERMISSIONS), cmd).toThrow(/may never call/);
    }
  });

  test("the high-value targets are each gated behind their own permission", () => {
    const all = ALL_PERMISSIONS;
    // Arbitrary shell execution.
    expect(() =>
      assertCommandAllowed(
        "p",
        "container_exec",
        all.filter((p) => p !== "containers"),
      ),
    ).toThrow();
    // Plaintext access tokens.
    expect(() =>
      assertCommandAllowed(
        "p",
        "git_auth_get_token",
        all.filter((p) => p !== "git:credentials"),
      ),
    ).toThrow();
    // Typing into a live shell.
    expect(() =>
      assertCommandAllowed(
        "p",
        "pty_write",
        all.filter((p) => p !== "terminal"),
      ),
    ).toThrow();
    // Repointing the Julia interpreter at an arbitrary binary.
    expect(() =>
      assertCommandAllowed(
        "p",
        "julia_set_path",
        all.filter((p) => p !== "julia:configure"),
      ),
    ).toThrow();
  });

  test("the error names the missing permission so the plugin author can fix it", () => {
    try {
      assertCommandAllowed("my-plugin", "julia_run", []);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PluginPermissionError);
      expect((e as Error).message).toContain("my-plugin");
      expect((e as Error).message).toContain("julia_run");
      expect((e as Error).message).toContain("julia:run");
    }
  });
});

describe("assertEventAllowed", () => {
  test("every event maps to a catalogued permission", () => {
    for (const [event, permission] of Object.entries(EVENT_PERMISSIONS)) {
      expect(PERMISSION_CATALOG[permission], `${event} -> ${permission}`).toBeDefined();
    }
  });

  test("allows an event covered by a granted permission", () => {
    expect(() => assertEventAllowed("p", "fs-changed", ["workspace:read"])).not.toThrow();
  });

  test("rejects an event whose permission was not granted", () => {
    expect(() => assertEventAllowed("p", "julia-output", ["workspace:read"])).toThrow(
      PluginPermissionError,
    );
  });

  test("fails closed on events that are not in the map", () => {
    // A newly emitted Tauri event must not become readable by every installed plugin
    // the day it lands.
    expect(() => assertEventAllowed("p", "some-future-event", ALL_PERMISSIONS)).toThrow(
      /may never listen to/,
    );
  });

  test("menu-command is never listenable, even with everything granted", () => {
    // It is how julIDE dispatches its own commands; a plugin watching it sees every
    // menu action the user takes.
    expect(() => assertEventAllowed("p", "menu-command", ALL_PERMISSIONS)).toThrow(
      /may never listen to/,
    );
  });

  test("the streams that carry user data are each gated behind their own permission", () => {
    const all = ALL_PERMISSIONS;
    // Stdout of everything the user runs.
    expect(() =>
      assertEventAllowed(
        "p",
        "julia-output",
        all.filter((p) => p !== "julia:run"),
      ),
    ).toThrow();
    // A live feed of their shell.
    expect(() =>
      assertEventAllowed(
        "p",
        "pty-output",
        all.filter((p) => p !== "terminal"),
      ),
    ).toThrow();
    // Carries file contents.
    expect(() =>
      assertEventAllowed(
        "p",
        "lsp-notification",
        all.filter((p) => p !== "lsp"),
      ),
    ).toThrow();
    // Every path they touch.
    expect(() =>
      assertEventAllowed(
        "p",
        "fs-changed",
        all.filter((p) => p !== "workspace:read"),
      ),
    ).toThrow();
  });

  test("the error says listen rather than call", () => {
    try {
      assertEventAllowed("my-plugin", "pty-output", []);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("listen to");
      expect((e as Error).message).toContain("terminal");
    }
  });
});

describe("own-property lookup", () => {
  test("inherited Object.prototype keys are not treated as mapped", () => {
    // Both maps are object literals, so `MAP["constructor"]` resolves to a function
    // without an own-property check — truthy, and exactly the shape that slips past a
    // `if (!required)` guard.
    for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      expect(() => assertCommandAllowed("p", key, ALL_PERMISSIONS), key).toThrow(/may never call/);
      expect(() => assertEventAllowed("p", key, ALL_PERMISSIONS), key).toThrow(
        /may never listen to/,
      );
    }
  });
});

describe("parsePermissions", () => {
  test("keeps known permissions and drops unknown ones", () => {
    expect(parsePermissions(["workspace:read", "not-a-permission", "julia:run"])).toEqual([
      "workspace:read",
      "julia:run",
    ]);
  });

  test("deduplicates", () => {
    expect(parsePermissions(["julia:run", "julia:run"])).toEqual(["julia:run"]);
  });

  test("handles a missing permissions field", () => {
    expect(parsePermissions(undefined)).toEqual([]);
  });

  test("unknownPermissions reports what was dropped", () => {
    expect(unknownPermissions(["workspace:read", "admin:everything"])).toEqual([
      "admin:everything",
    ]);
  });

  test("a wildcard is not a permission", () => {
    // Manifests must enumerate; there is deliberately no "grant me everything" token.
    expect(parsePermissions(["*"])).toEqual([]);
  });
});
