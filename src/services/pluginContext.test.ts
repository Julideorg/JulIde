import { describe, expect, test, beforeEach } from "bun:test";
import { createPluginContext } from "./pluginContext";
import { usePluginStore } from "../stores/usePluginStore";
import { useIdeStore } from "../stores/useIdeStore";
import { resetAllStores } from "../__test__/storeTestUtils";
import { invokeHandlers } from "../__test__/tauriMock";
import { ALL_PERMISSIONS } from "./pluginPermissions";

beforeEach(() => {
  resetAllStores();
});

describe("createPluginContext", () => {
  test("returns frozen context with pluginId", () => {
    const { context } = createPluginContext("my-plugin");

    expect(context.pluginId).toBe("my-plugin");
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.commands)).toBe(true);
    expect(Object.isFrozen(context.ui)).toBe(true);
    expect(Object.isFrozen(context.workspace)).toBe(true);
    expect(Object.isFrozen(context.editor)).toBe(true);
    expect(Object.isFrozen(context.ipc)).toBe(true);
    expect(Object.isFrozen(context.log)).toBe(true);
  });
});

describe("commands", () => {
  test("register adds command to plugin store with prefixed id", () => {
    const { context } = createPluginContext("test-plugin");
    context.commands.register("greet", "Greet", () => {});

    const cmd = usePluginStore.getState().commands.get("test-plugin.greet");
    expect(cmd).toBeDefined();
    expect(cmd?.label).toBe("Greet");
    expect(cmd?.pluginId).toBe("test-plugin");
    expect(cmd?.category).toBe("test-plugin");
  });

  test("register returns disposable that removes the command", () => {
    const { context } = createPluginContext("test-plugin");
    const disposable = context.commands.register("greet", "Greet", () => {});

    expect(usePluginStore.getState().commands.has("test-plugin.greet")).toBe(true);

    disposable.dispose();

    expect(usePluginStore.getState().commands.has("test-plugin.greet")).toBe(false);
  });

  test("execute calls the registered handler", async () => {
    const { context } = createPluginContext("test-plugin");
    let called = false;
    context.commands.register("action", "Action", () => {
      called = true;
    });

    await context.commands.execute("test-plugin.action");

    expect(called).toBe(true);
  });
});

describe("ui", () => {
  test("registerSidebarPanel adds panel with prefixed id and order 100", () => {
    const { context } = createPluginContext("my-plugin");
    context.ui.registerSidebarPanel({
      id: "panel",
      label: "My Panel",
      icon: "icon",
      render: () => {},
    });

    const panels = usePluginStore.getState().sidebarPanels;
    expect(panels).toHaveLength(1);
    expect(panels[0].id).toBe("my-plugin.panel");
    expect(panels[0].order).toBe(100);
    expect(panels[0].pluginId).toBe("my-plugin");
  });

  test("registerBottomPanel adds panel with prefixed id", () => {
    const { context } = createPluginContext("my-plugin");
    context.ui.registerBottomPanel({
      id: "output",
      label: "Output",
      render: () => {},
    });

    const panels = usePluginStore.getState().bottomPanels;
    expect(panels).toHaveLength(1);
    expect(panels[0].id).toBe("my-plugin.output");
  });

  test("registerStatusBarItem adds item with prefixed id", () => {
    const { context } = createPluginContext("my-plugin");
    context.ui.registerStatusBarItem({
      id: "status",
      text: "Ready",
      alignment: "left",
    });

    const items = usePluginStore.getState().statusBarItems;
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("my-plugin.status");
  });

  test("registerToolbarButton adds button with prefixed id", () => {
    const { context } = createPluginContext("my-plugin");
    context.ui.registerToolbarButton({
      id: "btn",
      label: "Click",
      icon: "play",
      onClick: () => {},
    });

    const btns = usePluginStore.getState().toolbarButtons;
    expect(btns).toHaveLength(1);
    expect(btns[0].id).toBe("my-plugin.btn");
    expect(btns[0].group).toBe("plugin");
  });

  test("showNotification appends to IDE output", () => {
    const { context } = createPluginContext("my-plugin");
    context.ui.showNotification("Something happened", "info");

    const output = useIdeStore.getState().output;
    expect(output).toHaveLength(1);
    expect(output[0].text).toContain("[my-plugin]");
    expect(output[0].text).toContain("Something happened");
    expect(output[0].kind).toBe("info");
  });

  test("showNotification with error type uses stderr kind", () => {
    const { context } = createPluginContext("my-plugin");
    context.ui.showNotification("Failed!", "error");

    expect(useIdeStore.getState().output[0].kind).toBe("stderr");
  });
});

describe("workspace", () => {
  test("getPath returns current workspacePath", () => {
    useIdeStore.setState({ workspacePath: "/my/workspace" });
    const { context } = createPluginContext("test");

    expect(context.workspace.getPath()).toBe("/my/workspace");
  });

  test("getPath returns null when no workspace", () => {
    const { context } = createPluginContext("test");
    expect(context.workspace.getPath()).toBeNull();
  });
});

describe("editor", () => {
  test("getActiveFilePath returns null when no tabs open", () => {
    const { context } = createPluginContext("test");
    expect(context.editor.getActiveFilePath()).toBeNull();
  });

  test("getActiveFilePath returns active tab path", () => {
    useIdeStore.getState().openFile({
      id: "tab-1",
      path: "/test/file.jl",
      name: "file.jl",
      content: "",
      isDirty: false,
      language: "julia",
    });

    const { context } = createPluginContext("test");
    expect(context.editor.getActiveFilePath()).toBe("/test/file.jl");
  });
});

describe("log", () => {
  test("info appends to output with info kind", () => {
    const { context } = createPluginContext("my-plugin");
    context.log.info("started");

    const line = useIdeStore.getState().output[0];
    expect(line.kind).toBe("info");
    expect(line.text).toBe("[my-plugin] started");
  });

  test("warn appends with WARN prefix", () => {
    const { context } = createPluginContext("my-plugin");
    context.log.warn("careful");

    expect(useIdeStore.getState().output[0].text).toBe("[my-plugin] WARN: careful");
  });

  test("error appends with stderr kind", () => {
    const { context } = createPluginContext("my-plugin");
    context.log.error("broken");

    const line = useIdeStore.getState().output[0];
    expect(line.kind).toBe("stderr");
    expect(line.text).toBe("[my-plugin] broken");
  });
});

describe("disposeAll", () => {
  test("removes all registered commands and panels", () => {
    const { context, disposeAll } = createPluginContext("test");

    context.commands.register("cmd1", "Cmd1", () => {});
    context.commands.register("cmd2", "Cmd2", () => {});
    context.ui.registerSidebarPanel({ id: "panel", label: "Panel", icon: "x", render: () => {} });
    context.ui.registerBottomPanel({ id: "bottom", label: "Bottom", render: () => {} });
    context.ui.registerStatusBarItem({ id: "status", text: "OK", alignment: "left" });
    context.ui.registerToolbarButton({ id: "btn", label: "Btn", icon: "x", onClick: () => {} });

    expect(usePluginStore.getState().commands.size).toBe(2);
    expect(usePluginStore.getState().sidebarPanels).toHaveLength(1);

    disposeAll();

    expect(usePluginStore.getState().commands.size).toBe(0);
    expect(usePluginStore.getState().sidebarPanels).toHaveLength(0);
    expect(usePluginStore.getState().bottomPanels).toHaveLength(0);
    expect(usePluginStore.getState().statusBarItems).toHaveLength(0);
    expect(usePluginStore.getState().toolbarButtons).toHaveLength(0);
  });
});

describe("ipc permission enforcement", () => {
  test("invoke succeeds for a granted command", async () => {
    invokeHandlers.set("fs_read_file", () => "contents");
    const { context } = createPluginContext("p", ["workspace:read"]);

    await expect(context.ipc.invoke("fs_read_file", { path: "/a.jl" })).resolves.toBe("contents");
  });

  test("invoke rejects an ungranted command without reaching the backend", async () => {
    let reached = false;
    invokeHandlers.set("fs_write_file", () => {
      reached = true;
    });
    const { context } = createPluginContext("p", ["workspace:read"]);

    await expect(
      context.ipc.invoke("fs_write_file", { path: "/a.jl", content: "x" }),
    ).rejects.toThrow(/workspace:write/);
    expect(reached).toBe(false);
  });

  test("a plugin with no declared permissions can call nothing", async () => {
    invokeHandlers.set("fs_read_file", () => "contents");
    const { context } = createPluginContext("p");

    await expect(context.ipc.invoke("fs_read_file", { path: "/a.jl" })).rejects.toThrow(
      /workspace:read/,
    );
  });

  test("the workspace helpers are gated too, not just ipc.invoke", async () => {
    // These are the friendlier API over the same commands — a plugin must not be
    // able to route around the check by preferring them.
    let wrote = false;
    invokeHandlers.set("fs_read_file", () => "contents");
    invokeHandlers.set("fs_write_file", () => {
      wrote = true;
    });

    const { context } = createPluginContext("p", ["workspace:read"]);

    await expect(context.workspace.readFile("/a.jl")).resolves.toBe("contents");
    await expect(context.workspace.writeFile("/a.jl", "x")).rejects.toThrow(/workspace:write/);
    expect(wrote).toBe(false);
  });

  test("plugin-management commands are refused even when everything is granted", async () => {
    let reached = false;
    invokeHandlers.set("plugin_grants_save", () => {
      reached = true;
    });
    const { context } = createPluginContext("p", ALL_PERMISSIONS);

    await expect(context.ipc.invoke("plugin_grants_save", { grants: {} })).rejects.toThrow(
      /may never call/,
    );
    expect(reached).toBe(false);
  });
});
