import { describe, expect, test, beforeEach } from "bun:test";
import { useIdeStore } from "./useIdeStore";
import { resetAllStores } from "../__test__/storeTestUtils";
import { invokeHandlers } from "../__test__/tauriMock";
import type { EditorTab } from "../types";

beforeEach(() => {
  resetAllStores();
});

function makeTab(overrides: Partial<EditorTab> = {}): EditorTab {
  return {
    id: "tab-1",
    path: "/test/file.jl",
    name: "file.jl",
    content: 'println("hello")',
    // A freshly opened tab matches disk, which is what makes isDirty derivable.
    savedContent: 'println("hello")',
    isDirty: false,
    language: "julia",
    ...overrides,
  };
}

// ── Tab management ──────────────────────────────────────────────────────────

describe("tab management", () => {
  test("openFile adds tab and sets activeTabId", () => {
    const tab = makeTab();
    useIdeStore.getState().openFile(tab);

    const state = useIdeStore.getState();
    expect(state.openTabs).toHaveLength(1);
    expect(state.openTabs[0].id).toBe("tab-1");
    expect(state.activeTabId).toBe("tab-1");
  });

  test("openFile with existing path reuses tab", () => {
    const tab1 = makeTab({ id: "tab-1", path: "/test/file.jl" });
    const tab2 = makeTab({ id: "tab-2", path: "/test/file.jl" });

    useIdeStore.getState().openFile(tab1);
    useIdeStore.getState().openFile(tab2);

    const state = useIdeStore.getState();
    expect(state.openTabs).toHaveLength(1);
    expect(state.activeTabId).toBe("tab-1"); // reuses existing
  });

  test("openFile with different path adds second tab", () => {
    const tab1 = makeTab({ id: "tab-1", path: "/test/a.jl" });
    const tab2 = makeTab({ id: "tab-2", path: "/test/b.jl" });

    useIdeStore.getState().openFile(tab1);
    useIdeStore.getState().openFile(tab2);

    const state = useIdeStore.getState();
    expect(state.openTabs).toHaveLength(2);
    expect(state.activeTabId).toBe("tab-2");
  });

  test("closeTab removes tab and selects adjacent", () => {
    const tab1 = makeTab({ id: "tab-1", path: "/test/a.jl" });
    const tab2 = makeTab({ id: "tab-2", path: "/test/b.jl" });
    const tab3 = makeTab({ id: "tab-3", path: "/test/c.jl" });

    useIdeStore.getState().openFile(tab1);
    useIdeStore.getState().openFile(tab2);
    useIdeStore.getState().openFile(tab3);
    useIdeStore.getState().setActiveTab("tab-2");

    useIdeStore.getState().closeTab("tab-2");

    const state = useIdeStore.getState();
    expect(state.openTabs).toHaveLength(2);
    expect(state.activeTabId).toBe("tab-1"); // selects previous
  });

  test("closeTab on last remaining tab sets activeTabId to null", () => {
    useIdeStore.getState().openFile(makeTab());
    useIdeStore.getState().closeTab("tab-1");

    expect(useIdeStore.getState().openTabs).toHaveLength(0);
    expect(useIdeStore.getState().activeTabId).toBeNull();
  });

  test("setActiveTab updates activeTabId", () => {
    useIdeStore.getState().openFile(makeTab({ id: "tab-1", path: "/a.jl" }));
    useIdeStore.getState().openFile(makeTab({ id: "tab-2", path: "/b.jl" }));
    useIdeStore.getState().setActiveTab("tab-1");

    expect(useIdeStore.getState().activeTabId).toBe("tab-1");
  });

  test("updateTabContent updates content and derives isDirty", () => {
    useIdeStore.getState().openFile(makeTab());
    useIdeStore.getState().updateTabContent("tab-1", "new content");

    const tab = useIdeStore.getState().openTabs[0];
    expect(tab.content).toBe("new content");
    expect(tab.isDirty).toBe(true);
  });

  test("editing back to the saved text clears isDirty, as in VS Code", () => {
    // Derived rather than latched, so undo puts the tab back the way it found it.
    useIdeStore.getState().openFile(makeTab({ content: "a", savedContent: "a" }));
    useIdeStore.getState().updateTabContent("tab-1", "ab");
    expect(useIdeStore.getState().openTabs[0].isDirty).toBe(true);

    useIdeStore.getState().updateTabContent("tab-1", "a");
    expect(useIdeStore.getState().openTabs[0].isDirty).toBe(false);
  });

  test("markTabSaved clears isDirty and moves the baseline to what was written", () => {
    useIdeStore.getState().openFile(makeTab({ content: "a", savedContent: "a" }));
    useIdeStore.getState().updateTabContent("tab-1", "edited");
    useIdeStore.getState().markTabSaved("tab-1");

    const tab = useIdeStore.getState().openTabs[0];
    expect(tab.isDirty).toBe(false);
    expect(tab.savedContent).toBe("edited");

    // And the old text is now an edit, rather than a return to the baseline.
    useIdeStore.getState().updateTabContent("tab-1", "a");
    expect(useIdeStore.getState().openTabs[0].isDirty).toBe(true);
  });

  test("resetTabContent adopts disk content as the new baseline", () => {
    // The external-change reload path: these bytes *are* what is on disk, so the tab
    // must come out clean rather than looking edited against the old baseline.
    useIdeStore.getState().openFile(makeTab({ content: "a", savedContent: "a" }));
    useIdeStore.getState().resetTabContent("tab-1", "changed on disk");

    const tab = useIdeStore.getState().openTabs[0];
    expect(tab.content).toBe("changed on disk");
    expect(tab.savedContent).toBe("changed on disk");
    expect(tab.isDirty).toBe(false);
  });
});

// ── Markdown preview ────────────────────────────────────────────────────────

describe("markdown preview", () => {
  const mdTab = (id: string) =>
    makeTab({ id, path: `/ws/${id}.md`, name: `${id}.md`, language: "md" });

  test("toggleTabViewMode flips between source and preview", () => {
    const ide = useIdeStore.getState();
    ide.openFile(mdTab("a"));

    ide.toggleTabViewMode("a");
    expect(useIdeStore.getState().openTabs[0].viewMode).toBe("preview");

    ide.toggleTabViewMode("a");
    expect(useIdeStore.getState().openTabs[0].viewMode).toBe("source");
  });

  test("toggleTabViewMode touches only the tab it names", () => {
    const ide = useIdeStore.getState();
    ide.openFile(mdTab("a"));
    ide.openFile(mdTab("b"));

    ide.toggleTabViewMode("a");

    const tabs = useIdeStore.getState().openTabs;
    expect(tabs.find((t) => t.id === "a")?.viewMode).toBe("preview");
    expect(tabs.find((t) => t.id === "b")?.viewMode).toBeUndefined();
  });

  test("openPreviewSplit claims the split pane", () => {
    useIdeStore.getState().openPreviewSplit("a");

    const s = useIdeStore.getState();
    expect(s.previewTabId).toBe("a");
    expect(s.splitEditorOpen).toBe(true);
  });

  test("closePreviewSplit releases the pane when nothing else wants it", () => {
    const ide = useIdeStore.getState();
    ide.openPreviewSplit("a");
    ide.closePreviewSplit();

    const s = useIdeStore.getState();
    expect(s.previewTabId).toBeNull();
    expect(s.splitEditorOpen).toBe(false);
  });

  test("closePreviewSplit leaves the pane open for a split editor", () => {
    const ide = useIdeStore.getState();
    ide.openPreviewSplit("a");
    ide.setSplitTab("b");
    ide.closePreviewSplit();

    const s = useIdeStore.getState();
    expect(s.previewTabId).toBeNull();
    expect(s.splitEditorOpen).toBe(true);
  });

  test("closing the previewed tab clears the preview rather than stranding it", () => {
    const ide = useIdeStore.getState();
    ide.openFile(mdTab("a"));
    ide.openPreviewSplit("a");

    ide.closeTab("a");

    const s = useIdeStore.getState();
    expect(s.previewTabId).toBeNull();
    expect(s.splitEditorOpen).toBe(false);
  });

  test("closing an unrelated tab leaves the preview alone", () => {
    const ide = useIdeStore.getState();
    ide.openFile(mdTab("a"));
    ide.openFile(mdTab("b"));
    ide.openPreviewSplit("a");

    ide.closeTab("b");

    expect(useIdeStore.getState().previewTabId).toBe("a");
  });
});

// ── Output ──────────────────────────────────────────────────────────────────

describe("output", () => {
  test("appendOutput adds line with id and timestamp", () => {
    useIdeStore.getState().appendOutput({ kind: "stdout", text: "hello" });

    const output = useIdeStore.getState().output;
    expect(output).toHaveLength(1);
    expect(output[0].text).toBe("hello");
    expect(output[0].kind).toBe("stdout");
    expect(output[0].id).toBeDefined();
    expect(output[0].timestamp).toBeGreaterThan(0);
  });

  test("appendOutput truncates at 5000 lines", () => {
    const store = useIdeStore.getState();
    for (let i = 0; i < 5005; i++) {
      store.appendOutput({ kind: "stdout", text: `line ${i}` });
    }

    const output = useIdeStore.getState().output;
    expect(output.length).toBeLessThanOrEqual(5000);
  });

  test("clearOutput empties array", () => {
    useIdeStore.getState().appendOutput({ kind: "stdout", text: "hello" });
    useIdeStore.getState().clearOutput();

    expect(useIdeStore.getState().output).toHaveLength(0);
  });
});

// ── Breakpoints ─────────────────────────────────────────────────────────────

describe("breakpoints", () => {
  test("addBreakpoint adds new breakpoint", () => {
    useIdeStore.getState().addBreakpoint({ file: "/test.jl", line: 10 });

    expect(useIdeStore.getState().breakpoints).toHaveLength(1);
    expect(useIdeStore.getState().breakpoints[0]).toEqual({ file: "/test.jl", line: 10 });
  });

  test("addBreakpoint does not duplicate", () => {
    useIdeStore.getState().addBreakpoint({ file: "/test.jl", line: 10 });
    useIdeStore.getState().addBreakpoint({ file: "/test.jl", line: 10 });

    expect(useIdeStore.getState().breakpoints).toHaveLength(1);
  });

  test("removeBreakpoint removes by file+line", () => {
    useIdeStore.getState().addBreakpoint({ file: "/test.jl", line: 10 });
    useIdeStore.getState().addBreakpoint({ file: "/test.jl", line: 20 });
    useIdeStore.getState().removeBreakpoint("/test.jl", 10);

    const bps = useIdeStore.getState().breakpoints;
    expect(bps).toHaveLength(1);
    expect(bps[0].line).toBe(20);
  });

  test("toggleBreakpoint adds if absent, removes if present", () => {
    useIdeStore.getState().toggleBreakpoint("/test.jl", 5);
    expect(useIdeStore.getState().breakpoints).toHaveLength(1);

    useIdeStore.getState().toggleBreakpoint("/test.jl", 5);
    expect(useIdeStore.getState().breakpoints).toHaveLength(0);
  });
});

// ── Split editor ────────────────────────────────────────────────────────────

describe("split editor", () => {
  test("toggleSplitEditor opens with splitTabId defaulting to activeTabId", () => {
    useIdeStore.getState().openFile(makeTab());
    useIdeStore.getState().toggleSplitEditor();

    const state = useIdeStore.getState();
    expect(state.splitEditorOpen).toBe(true);
    expect(state.splitTabId).toBe("tab-1");
  });

  test("toggleSplitEditor again closes and clears splitTabId", () => {
    useIdeStore.getState().openFile(makeTab());
    useIdeStore.getState().toggleSplitEditor();
    useIdeStore.getState().toggleSplitEditor();

    const state = useIdeStore.getState();
    expect(state.splitEditorOpen).toBe(false);
    expect(state.splitTabId).toBeNull();
  });
});

// ── Terminal sessions ───────────────────────────────────────────────────────

describe("terminal sessions", () => {
  test("addTerminalSession adds session and sets active", () => {
    useIdeStore.getState().addTerminalSession({ id: "term-1", name: "Julia REPL" });

    const state = useIdeStore.getState();
    expect(state.terminalSessions).toHaveLength(1);
    expect(state.activeTerminalId).toBe("term-1");
  });

  test("removeTerminalSession removes and selects first remaining", () => {
    useIdeStore.getState().addTerminalSession({ id: "term-1", name: "REPL 1" });
    useIdeStore.getState().addTerminalSession({ id: "term-2", name: "REPL 2" });
    useIdeStore.getState().removeTerminalSession("term-2");

    const state = useIdeStore.getState();
    expect(state.terminalSessions).toHaveLength(1);
    expect(state.activeTerminalId).toBe("term-1");
  });

  test("removeTerminalSession on active selects fallback", () => {
    useIdeStore.getState().addTerminalSession({ id: "term-1", name: "REPL 1" });
    useIdeStore.getState().removeTerminalSession("term-1");

    expect(useIdeStore.getState().activeTerminalId).toBeNull();
  });
});

// ── refreshGit ──────────────────────────────────────────────────────────────

describe("refreshGit", () => {
  test("refreshGit updates git state from mocked invoke", async () => {
    useIdeStore.setState({ workspacePath: "/workspace" });

    invokeHandlers.set("git_is_repo", () => true);
    invokeHandlers.set("git_branch_current", () => "main");
    invokeHandlers.set("git_branches", () => ["main", "dev"]);
    invokeHandlers.set("git_status", () => []);
    invokeHandlers.set("git_provider_detect", () => "github");
    invokeHandlers.set("git_remotes", () => [
      { name: "origin", url: "https://github.com/user/repo" },
    ]);
    invokeHandlers.set("git_stash_list", () => []);
    invokeHandlers.set("git_ahead_behind", () => [2, 1]);

    await useIdeStore.getState().refreshGit();

    const state = useIdeStore.getState();
    expect(state.gitIsRepo).toBe(true);
    expect(state.gitBranch).toBe("main");
    expect(state.gitBranches).toEqual(["main", "dev"]);
    expect(state.gitProvider).toBe("github");
    expect(state.gitAheadBehind).toEqual({ ahead: 2, behind: 1 });
  });

  test("refreshGit does nothing without workspacePath", async () => {
    await useIdeStore.getState().refreshGit();
    expect(useIdeStore.getState().gitIsRepo).toBe(false);
  });
});
