import { beforeEach, describe, expect, test } from "bun:test";
import {
  createHostDispatcher,
  type DispatcherDeps,
  type FrameRole,
  type StatusBarItemSpec,
  type ToolbarButtonSpec,
} from "./dispatcher";
import { ALL_PERMISSIONS, type PluginPermission } from "../pluginPermissions";
import type { RpcRequest, RpcResponse } from "./protocol";

/** Records everything the dispatcher reached for, so tests can assert on it. */
function makeDeps() {
  const calls = {
    invoked: [] as { command: string; args?: Record<string, unknown> }[],
    listened: [] as string[],
    unlistened: 0,
    registered: [] as string[],
    unregistered: [] as string[],
    executed: [] as string[],
    statusItems: [] as StatusBarItemSpec[],
    removedStatusItems: [] as string[],
    toolbarButtons: [] as ToolbarButtonSpec[],
    removedToolbarButtons: [] as string[],
    notifications: [] as { message: string; type: string }[],
    logs: [] as { level: string; message: string }[],
    viewTitles: [] as { viewId: string; title: string }[],
    viewBadges: [] as { viewId: string; badge: unknown }[],
    emitted: [] as { subscription: number; payload: unknown }[],
  };
  /** Fires whatever a live subscription is listening to. */
  const listeners = new Map<string, (payload: unknown) => void>();
  const owners = new Map<string, string>();

  const deps: DispatcherDeps = {
    invoke: async (command, args) => {
      calls.invoked.push({ command, args });
      return `result:${command}`;
    },
    listen: async (event, cb) => {
      calls.listened.push(event);
      listeners.set(event, cb);
      return () => {
        calls.unlistened += 1;
      };
    },
    getWorkspacePath: () => "/home/someone/project",
    getActiveFilePath: () => "/home/someone/project/a.jl",
    getSelectedText: () => "secret = 1",
    registerCommand: (id) => {
      calls.registered.push(id);
    },
    unregisterCommand: (id) => {
      calls.unregistered.push(id);
    },
    executeCommand: async (id) => {
      calls.executed.push(id);
    },
    commandOwner: (id) => owners.get(id),
    setStatusBarItem: (item) => {
      calls.statusItems.push(item);
    },
    removeStatusBarItem: (id) => {
      calls.removedStatusItems.push(id);
    },
    setToolbarButton: (b) => {
      calls.toolbarButtons.push(b);
    },
    removeToolbarButton: (id) => {
      calls.removedToolbarButtons.push(id);
    },
    setViewTitle: (viewId, title) => {
      calls.viewTitles.push({ viewId, title });
    },
    setViewBadge: (viewId, badge) => {
      calls.viewBadges.push({ viewId, badge });
    },
    showNotification: (message, type) => {
      calls.notifications.push({ message, type });
    },
    log: (level, message) => {
      calls.logs.push({ level, message });
    },
    emitToFrame: (subscription, payload) => {
      calls.emitted.push({ subscription, payload });
    },
  };
  return { deps, calls, listeners, owners };
}

let ctx: ReturnType<typeof makeDeps>;
let id = 0;

function make(
  granted: readonly PluginPermission[] = [],
  role: FrameRole = "background",
  viewId?: string,
) {
  return createHostDispatcher({ pluginId: "p", granted, role, viewId, deps: ctx.deps });
}

function req(method: string, params?: unknown): RpcRequest {
  return { kind: "req", id: id++, method, params };
}

function expectOk(res: RpcResponse) {
  if (!res.ok) throw new Error(`expected ok, got ${res.error?.code}: ${res.error?.message}`);
  return res.value;
}

function expectFail(res: RpcResponse) {
  if (res.ok) throw new Error("expected failure");
  return res.error!;
}

beforeEach(() => {
  ctx = makeDeps();
});

describe("ipc.invoke", () => {
  test("a granted command reaches the backend", async () => {
    const d = make(["workspace:read"]);
    const value = expectOk(
      await d.handle(req("ipc.invoke", { command: "fs_read_file", args: { path: "/a.jl" } })),
    );
    expect(value).toBe("result:fs_read_file");
    expect(ctx.calls.invoked).toEqual([{ command: "fs_read_file", args: { path: "/a.jl" } }]);
  });

  test("an ungranted command never reaches the backend", async () => {
    const d = make(["workspace:read"]);
    const err = expectFail(await d.handle(req("ipc.invoke", { command: "fs_write_file" })));
    expect(err.code).toBe("permission-denied");
    expect(err.permission).toBe("workspace:write");
    expect(ctx.calls.invoked).toEqual([]);
  });

  test("an unmapped command is refused even with everything granted", async () => {
    // Fails closed, so a newly added Tauri command is not reachable by default.
    const d = make(ALL_PERMISSIONS);
    const err = expectFail(await d.handle(req("ipc.invoke", { command: "some_future_command" })));
    expect(err.code).toBe("forbidden-target");
    expect(ctx.calls.invoked).toEqual([]);
  });

  test("plugin and marketplace management commands are never reachable", async () => {
    const d = make(ALL_PERMISSIONS);
    for (const command of ["plugin_scan", "plugin_get_dir", "plugin_grants_save"]) {
      expect(expectFail(await d.handle(req("ipc.invoke", { command }))).code, command).toBe(
        "forbidden-target",
      );
    }
    expect(ctx.calls.invoked).toEqual([]);
  });

  test("a malformed request is rejected without touching the backend", async () => {
    const d = make(ALL_PERMISSIONS);
    expect(expectFail(await d.handle(req("ipc.invoke", { command: 42 }))).code).toBe(
      "invalid-params",
    );
    expect(expectFail(await d.handle(req("ipc.invoke", "not an object"))).code).toBe(
      "invalid-params",
    );
    expect(
      expectFail(await d.handle(req("ipc.invoke", { command: "fs_read_file", args: [1, 2] }))).code,
    ).toBe("invalid-params");
    expect(ctx.calls.invoked).toEqual([]);
  });
});

describe("workspace and editor reads", () => {
  test("all of them need workspace:read", async () => {
    const d = make([]);
    for (const method of [
      "workspace.getPath",
      "editor.getActiveFilePath",
      "editor.getSelectedText",
    ]) {
      const err = expectFail(await d.handle(req(method)));
      expect(err.code, method).toBe("permission-denied");
      expect(err.permission, method).toBe("workspace:read");
    }
  });

  test("with the permission they return the real values", async () => {
    const d = make(["workspace:read"]);
    expect(expectOk(await d.handle(req("workspace.getPath")))).toBe("/home/someone/project");
    expect(expectOk(await d.handle(req("editor.getSelectedText")))).toBe("secret = 1");
  });

  test("the convenience file helpers are gated like the raw commands", async () => {
    // A plugin must not route around the check by preferring the friendlier API.
    const d = make(["workspace:read"]);
    expect(expectOk(await d.handle(req("workspace.readFile", { path: "/a.jl" })))).toBe(
      "result:fs_read_file",
    );
    const err = expectFail(
      await d.handle(req("workspace.writeFile", { path: "/a.jl", content: "x" })),
    );
    expect(err.permission).toBe("workspace:write");
    expect(ctx.calls.invoked.map((c) => c.command)).toEqual(["fs_read_file"]);
  });
});

describe("event subscription", () => {
  test("subscribing requires the matching permission", async () => {
    const d = make(["workspace:read"]);
    const err = expectFail(await d.handle(req("ipc.subscribe", { event: "julia-output" })));
    expect(err.code).toBe("permission-denied");
    expect(err.permission).toBe("julia:run");
    expect(ctx.calls.listened).toEqual([]);
  });

  test("an unmapped event is refused with everything granted", async () => {
    const d = make(ALL_PERMISSIONS);
    expect(
      expectFail(await d.handle(req("ipc.subscribe", { event: "some-future-event" }))).code,
    ).toBe("forbidden-target");
  });

  test("menu-command is never subscribable", async () => {
    // Host chrome: it is how julIDE dispatches its own commands.
    const d = make(ALL_PERMISSIONS);
    expect(expectFail(await d.handle(req("ipc.subscribe", { event: "menu-command" }))).code).toBe(
      "forbidden-target",
    );
  });

  test("events reach the frame under their subscription id", async () => {
    const d = make(["terminal"]);
    const sub = expectOk(await d.handle(req("ipc.subscribe", { event: "pty-output" })));
    ctx.listeners.get("pty-output")!({ data: "hello" });
    expect(ctx.calls.emitted).toEqual([
      { subscription: sub as number, payload: { data: "hello" } },
    ]);
  });

  test("unsubscribing stops delivery and releases the host listener", async () => {
    const d = make(["terminal"]);
    const sub = expectOk(await d.handle(req("ipc.subscribe", { event: "pty-output" })));
    expectOk(await d.handle(req("ipc.unsubscribe", { subscription: sub })));

    ctx.listeners.get("pty-output")!({ data: "after" });
    expect(ctx.calls.emitted).toEqual([]);
    expect(ctx.calls.unlistened).toBe(1);
  });

  test("subscriptions are capped", async () => {
    const d = make(["terminal"]);
    for (let i = 0; i < 32; i++) {
      expectOk(await d.handle(req("ipc.subscribe", { event: "pty-output" })));
    }
    expect(expectFail(await d.handle(req("ipc.subscribe", { event: "pty-output" }))).code).toBe(
      "invalid-params",
    );
  });

  test("workspace.subscribeFileChanges is gated like the raw event", async () => {
    expect(
      expectFail(await make([]).handle(req("workspace.subscribeFileChanges"))).permission,
    ).toBe("workspace:read");
    expectOk(await make(["workspace:read"]).handle(req("workspace.subscribeFileChanges")));
    expect(ctx.calls.listened).toEqual(["fs-changed"]);
  });
});

describe("commands.execute stays inside the plugin's namespace", () => {
  test("a built-in command is unreachable", async () => {
    // julIDE's own commands share the registry and their handlers invoke Tauri
    // directly. `julia.run` from a plugin is arbitrary code execution.
    ctx.owners.set("julia.run", undefined as unknown as string);
    const d = make(ALL_PERMISSIONS);
    const err = expectFail(await d.handle(req("commands.execute", { id: "julia.run" })));
    expect(err.code).toBe("forbidden-target");
    expect(ctx.calls.executed).toEqual([]);
  });

  test("another plugin's command is unreachable", async () => {
    ctx.owners.set("victim.secret", "victim");
    const d = make();
    expectFail(await d.handle(req("commands.execute", { id: "victim.secret" })));
    expect(ctx.calls.executed).toEqual([]);
  });

  test("a dotted plugin name is not a usable prefix", async () => {
    // "p" is a string-prefix of "p.other", so the prefix test alone is not enough.
    ctx.owners.set("p.other.cmd", "p.other");
    const d = make();
    expectFail(await d.handle(req("commands.execute", { id: "p.other.cmd" })));
    expect(ctx.calls.executed).toEqual([]);
  });

  test("the plugin's own command runs", async () => {
    ctx.owners.set("p.go", "p");
    const d = make();
    expectOk(await d.handle(req("commands.execute", { id: "p.go" })));
    expect(ctx.calls.executed).toEqual(["p.go"]);
  });

  test("an unregistered id in the plugin's namespace is not an error", async () => {
    // Nothing is revealed either way, and a plugin racing its own registration
    // should not see a spurious failure.
    const d = make();
    expectOk(await d.handle(req("commands.execute", { id: "p.not-yet" })));
  });
});

describe("frame roles", () => {
  test("a view frame cannot register commands or chrome", async () => {
    // The bundle runs in every view frame too, so without this a two-panel plugin
    // would register its contributions three times over.
    const d = make(ALL_PERMISSIONS, "view", "log");
    for (const method of [
      "commands.register",
      "ui.setStatusBarItem",
      "ui.setToolbarButton",
      "ui.removeStatusBarItem",
    ]) {
      expect(
        expectFail(await d.handle(req(method, { id: "x", label: "X", text: "X" }))).code,
        method,
      ).toBe("wrong-role");
    }
    expect(ctx.calls.registered).toEqual([]);
  });

  test("a background frame cannot drive a view", async () => {
    const d = make(ALL_PERMISSIONS, "background");
    expect(expectFail(await d.handle(req("view.setTitle", { title: "X" }))).code).toBe(
      "wrong-role",
    );
  });

  test("a view frame can set its own title and badge", async () => {
    const d = make([], "view", "log");
    expectOk(await d.handle(req("view.setTitle", { title: "Output" })));
    expectOk(await d.handle(req("view.setBadge", { badge: 3 })));
    expect(ctx.calls.viewTitles).toEqual([{ viewId: "log", title: "Output" }]);
    expect(ctx.calls.viewBadges).toEqual([{ viewId: "log", badge: 3 }]);
  });

  test("both roles may invoke, subscribe, notify and log", async () => {
    const d = make(["workspace:read"], "view", "log");
    expectOk(await d.handle(req("workspace.readFile", { path: "/a.jl" })));
    expectOk(await d.handle(req("ui.showNotification", { message: "hi", type: "info" })));
    expectOk(await d.handle(req("log.write", { level: "warn", message: "careful" })));
    expect(ctx.calls.logs).toEqual([{ level: "warn", message: "careful" }]);
  });
});

describe("host chrome is data, and bounded", () => {
  test("ids are namespaced so plugins cannot collide", async () => {
    const d = make();
    expectOk(await d.handle(req("commands.register", { id: "go", label: "Go" })));
    expectOk(await d.handle(req("ui.setStatusBarItem", { id: "s", text: "Ready" })));
    expect(ctx.calls.registered).toEqual(["p.go"]);
    expect(ctx.calls.statusItems[0]!.id).toBe("p.s");
  });

  test("status bar items are capped so a plugin cannot crowd out the IDE's own", async () => {
    const d = make();
    for (let i = 0; i < 4; i++) {
      expectOk(await d.handle(req("ui.setStatusBarItem", { id: `s${i}`, text: "x" })));
    }
    expect(
      expectFail(await d.handle(req("ui.setStatusBarItem", { id: "s5", text: "x" }))).code,
    ).toBe("invalid-params");
    // Updating one that already exists is not a new item.
    expectOk(await d.handle(req("ui.setStatusBarItem", { id: "s0", text: "updated" })));
  });

  test("toolbar buttons are capped too", async () => {
    const d = make();
    for (let i = 0; i < 4; i++) {
      expectOk(
        await d.handle(req("ui.setToolbarButton", { id: `b${i}`, label: "B", icon: "Puzzle" })),
      );
    }
    expect(
      expectFail(
        await d.handle(req("ui.setToolbarButton", { id: "b5", label: "B", icon: "Puzzle" })),
      ).code,
    ).toBe("invalid-params");
  });

  test("status bar text is length-capped", async () => {
    const d = make();
    expect(
      expectFail(await d.handle(req("ui.setStatusBarItem", { id: "s", text: "x".repeat(200) })))
        .code,
    ).toBe("invalid-params");
  });

  test("only built-in icon names are accepted", async () => {
    // An arbitrary icon string reaching an <img src> is an exfiltration channel.
    const d = make();
    for (const icon of ["https://evil.com/x.png", "<svg onload=alert(1)>", "NotAnIcon", 42]) {
      expect(
        expectFail(await d.handle(req("ui.setToolbarButton", { id: "b", label: "B", icon }))).code,
        String(icon),
      ).toBe("invalid-params");
    }
    expectOk(await d.handle(req("ui.setToolbarButton", { id: "b", label: "B", icon: "Puzzle" })));
  });

  test("an unknown notification type falls back to info rather than passing through", async () => {
    const d = make();
    expectOk(await d.handle(req("ui.showNotification", { message: "hi", type: "critical" })));
    expect(ctx.calls.notifications).toEqual([{ message: "hi", type: "info" }]);
  });
});

describe("unknown methods", () => {
  test("are refused by name", async () => {
    const d = make(ALL_PERMISSIONS);
    const err = expectFail(await d.handle(req("fs.deleteEverything")));
    expect(err.code).toBe("unknown-method");
    expect(err.message).toContain("fs.deleteEverything");
  });

  test("a prototype key is not a method", async () => {
    const d = make(ALL_PERMISSIONS);
    for (const method of ["constructor", "toString", "__proto__"]) {
      expect(expectFail(await d.handle(req(method))).code, method).toBe("unknown-method");
    }
  });
});

describe("revoke and dispose", () => {
  test("revoke strips capabilities from a live dispatcher", async () => {
    const d = make(["workspace:read"]);
    expectOk(await d.handle(req("workspace.getPath")));

    d.revoke();

    expect(expectFail(await d.handle(req("workspace.getPath"))).code).toBe("permission-denied");
    expect(expectFail(await d.handle(req("workspace.readFile", { path: "/a.jl" }))).code).toBe(
      "permission-denied",
    );
  });

  test("dispose releases listeners and removes every contribution", async () => {
    const d = make(["terminal"]);
    expectOk(await d.handle(req("ipc.subscribe", { event: "pty-output" })));
    expectOk(await d.handle(req("commands.register", { id: "go", label: "Go" })));
    expectOk(await d.handle(req("ui.setStatusBarItem", { id: "s", text: "x" })));
    expectOk(await d.handle(req("ui.setToolbarButton", { id: "b", label: "B", icon: "Puzzle" })));

    await d.dispose();

    expect(ctx.calls.unlistened).toBe(1);
    expect(ctx.calls.unregistered).toEqual(["p.go"]);
    expect(ctx.calls.removedStatusItems).toEqual(["p.s"]);
    expect(ctx.calls.removedToolbarButtons).toEqual(["p.b"]);
  });

  test("after dispose every method fails rather than half-working", async () => {
    const d = make(ALL_PERMISSIONS);
    await d.dispose();
    expect(expectFail(await d.handle(req("ipc.invoke", { command: "fs_read_file" }))).code).toBe(
      "disposed",
    );
    expect(ctx.calls.invoked).toEqual([]);
  });

  test("a disposed dispatcher stops delivering events already subscribed", async () => {
    const d = make(["terminal"]);
    expectOk(await d.handle(req("ipc.subscribe", { event: "pty-output" })));
    await d.dispose();

    ctx.listeners.get("pty-output")!({ data: "after" });
    expect(ctx.calls.emitted).toEqual([]);
  });
});

describe("the response envelope", () => {
  test("carries the request's correlation id on success and failure", async () => {
    const d = make();
    const a = await d.handle({ kind: "req", id: 7, method: "log.write", params: { message: "x" } });
    expect(a).toMatchObject({ kind: "res", id: 7, ok: true });

    const b = await d.handle({ kind: "req", id: 9, method: "nope" });
    expect(b).toMatchObject({ kind: "res", id: 9, ok: false });
  });

  test("a backend failure is reported, not thrown", async () => {
    // The dispatcher is driven by a message loop; throwing would kill the loop for
    // every subsequent request rather than failing the one.
    ctx.deps.invoke = async () => {
      throw new Error("backend exploded");
    };
    const d = make(["workspace:read"]);
    const err = expectFail(await d.handle(req("ipc.invoke", { command: "fs_read_file" })));
    expect(err.code).toBe("internal");
    expect(err.message).toBe("backend exploded");
  });
});
