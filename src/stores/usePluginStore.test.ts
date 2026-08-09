import { describe, expect, test, beforeEach } from "bun:test";
import { usePluginStore } from "./usePluginStore";
import { resetAllStores } from "../__test__/storeTestUtils";
import type {
  CommandContribution,
  SidebarPanelContribution,
  BottomPanelContribution,
  StatusBarItemContribution,
  ToolbarButtonContribution,
} from "../types/plugin";

/** These tests are about registration and ordering, not about what a panel renders. */
const STUB_CONTENT = { kind: "component" as const, component: () => null };

beforeEach(() => {
  resetAllStores();
});

// ── Commands ────────────────────────────────────────────────────────────────

describe("commands", () => {
  test("registerCommand adds to map", () => {
    const cmd: CommandContribution = {
      id: "test.hello",
      label: "Hello",
      execute: () => {},
    };
    usePluginStore.getState().registerCommand(cmd);

    expect(usePluginStore.getState().commands.has("test.hello")).toBe(true);
    expect(usePluginStore.getState().commands.get("test.hello")?.label).toBe("Hello");
  });

  test("unregisterCommand removes from map", () => {
    usePluginStore.getState().registerCommand({ id: "test.cmd", label: "Cmd", execute: () => {} });
    usePluginStore.getState().unregisterCommand("test.cmd");

    expect(usePluginStore.getState().commands.has("test.cmd")).toBe(false);
  });

  test("registerCommand overwrites existing by same id", () => {
    usePluginStore.getState().registerCommand({ id: "test.cmd", label: "V1", execute: () => {} });
    usePluginStore.getState().registerCommand({ id: "test.cmd", label: "V2", execute: () => {} });

    expect(usePluginStore.getState().commands.get("test.cmd")?.label).toBe("V2");
    expect(usePluginStore.getState().commands.size).toBe(1);
  });
});

// ── Sidebar Panels ──────────────────────────────────────────────────────────

describe("sidebar panels", () => {
  const makePanel = (id: string, order: number): SidebarPanelContribution => ({
    id,
    content: STUB_CONTENT,
    label: id,
    icon: "icon",
    order,
  });

  test("registerSidebarPanel adds in sorted order", () => {
    usePluginStore.getState().registerSidebarPanel(makePanel("b", 20));
    usePluginStore.getState().registerSidebarPanel(makePanel("a", 10));

    const panels = usePluginStore.getState().sidebarPanels;
    expect(panels).toHaveLength(2);
    expect(panels[0].id).toBe("a");
    expect(panels[1].id).toBe("b");
  });

  test("registerSidebarPanel upserts existing id", () => {
    usePluginStore.getState().registerSidebarPanel(makePanel("a", 10));
    usePluginStore.getState().registerSidebarPanel({ ...makePanel("a", 10), label: "Updated" });

    const panels = usePluginStore.getState().sidebarPanels;
    expect(panels).toHaveLength(1);
    expect(panels[0].label).toBe("Updated");
  });

  test("unregisterSidebarPanel removes by id", () => {
    usePluginStore.getState().registerSidebarPanel(makePanel("a", 10));
    usePluginStore.getState().unregisterSidebarPanel("a");

    expect(usePluginStore.getState().sidebarPanels).toHaveLength(0);
  });
});

// ── Bottom Panels ───────────────────────────────────────────────────────────

describe("bottom panels", () => {
  const makePanel = (id: string, order: number): BottomPanelContribution => ({
    id,
    content: STUB_CONTENT,
    label: id,
    order,
  });

  test("registerBottomPanel adds in sorted order", () => {
    usePluginStore.getState().registerBottomPanel(makePanel("output", 20));
    usePluginStore.getState().registerBottomPanel(makePanel("terminal", 10));

    const panels = usePluginStore.getState().bottomPanels;
    expect(panels[0].id).toBe("terminal");
    expect(panels[1].id).toBe("output");
  });

  test("unregisterBottomPanel removes by id", () => {
    usePluginStore.getState().registerBottomPanel(makePanel("output", 10));
    usePluginStore.getState().unregisterBottomPanel("output");

    expect(usePluginStore.getState().bottomPanels).toHaveLength(0);
  });
});

// ── Status Bar Items ────────────────────────────────────────────────────────

describe("status bar items", () => {
  const makeItem = (id: string, order: number): StatusBarItemContribution => ({
    id,
    text: id,
    alignment: "left",
    order,
  });

  test("registerStatusBarItem adds in sorted order", () => {
    usePluginStore.getState().registerStatusBarItem(makeItem("b", 20));
    usePluginStore.getState().registerStatusBarItem(makeItem("a", 10));

    const items = usePluginStore.getState().statusBarItems;
    expect(items[0].id).toBe("a");
    expect(items[1].id).toBe("b");
  });

  test("unregisterStatusBarItem removes by id", () => {
    usePluginStore.getState().registerStatusBarItem(makeItem("a", 10));
    usePluginStore.getState().unregisterStatusBarItem("a");

    expect(usePluginStore.getState().statusBarItems).toHaveLength(0);
  });
});

// ── Toolbar Buttons ─────────────────────────────────────────────────────────

describe("toolbar buttons", () => {
  const makeBtn = (id: string, order: number): ToolbarButtonContribution => ({
    id,
    label: id,
    icon: "icon",
    order,
    group: "default",
  });

  test("registerToolbarButton adds in sorted order", () => {
    usePluginStore.getState().registerToolbarButton(makeBtn("run", 20));
    usePluginStore.getState().registerToolbarButton(makeBtn("debug", 10));

    const btns = usePluginStore.getState().toolbarButtons;
    expect(btns[0].id).toBe("debug");
    expect(btns[1].id).toBe("run");
  });

  test("unregisterToolbarButton removes by id", () => {
    usePluginStore.getState().registerToolbarButton(makeBtn("run", 10));
    usePluginStore.getState().unregisterToolbarButton("run");

    expect(usePluginStore.getState().toolbarButtons).toHaveLength(0);
  });
});
