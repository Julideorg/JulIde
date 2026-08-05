import { describe, expect, test } from "bun:test";
import {
  ALL_PERMISSIONS,
  COMMAND_PERMISSIONS,
  PERMISSION_CATALOG,
  PluginPermissionError,
  assertCommandAllowed,
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
    expect(() =>
      assertCommandAllowed("p", "fs_read_file", ["workspace:read"]),
    ).not.toThrow();
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
    for (const cmd of ["plugin_scan", "plugin_read_entry", "plugin_get_dir", "plugin_grants_save"]) {
      expect(() => assertCommandAllowed("p", cmd, ALL_PERMISSIONS), cmd).toThrow(
        /may never call/,
      );
    }
  });

  test("the high-value targets are each gated behind their own permission", () => {
    const all = ALL_PERMISSIONS;
    // Arbitrary shell execution.
    expect(() =>
      assertCommandAllowed("p", "container_exec", all.filter((p) => p !== "containers")),
    ).toThrow();
    // Plaintext access tokens.
    expect(() =>
      assertCommandAllowed("p", "git_auth_get_token", all.filter((p) => p !== "git:credentials")),
    ).toThrow();
    // Typing into a live shell.
    expect(() =>
      assertCommandAllowed("p", "pty_write", all.filter((p) => p !== "terminal")),
    ).toThrow();
    // Repointing the Julia interpreter at an arbitrary binary.
    expect(() =>
      assertCommandAllowed("p", "julia_set_path", all.filter((p) => p !== "julia:configure")),
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
