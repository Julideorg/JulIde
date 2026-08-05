import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { installMenuCommandListener } from "./menuCommands";
import { registerBuiltinContributions } from "./builtinContributions";
import { usePluginStore } from "../stores/usePluginStore";
import { useIdeStore } from "../stores/useIdeStore";
import { emitMockEvent, resetTauriMocks } from "../__test__/tauriMock";
import { resetAllStores } from "../__test__/storeTestUtils";

beforeEach(() => {
  resetAllStores();
  resetTauriMocks();
});

describe("native menu wiring", () => {
  test("every command id in menu.rs is actually registered", async () => {
    // The menu lives in Rust and the implementations live in TS, so nothing at
    // compile time connects them. A typo'd or renamed id would produce a menu
    // entry that silently does nothing — this is the guard against that.
    const menuSource = readFileSync("src-tauri/src/menu.rs", "utf8");
    const ids = [...menuSource.matchAll(/cmd_item!\(\s*"[^"]*",\s*"([^"]+)"/g)].map((m) => m[1]);

    expect(ids.length).toBeGreaterThan(10);

    await registerBuiltinContributions();
    const registered = usePluginStore.getState().commands;

    const missing = ids.filter((id) => !registered.has(id));
    expect(missing).toEqual([]);
  });
});

describe("installMenuCommandListener", () => {
  test("runs the command named by the event", async () => {
    let ran = false;
    usePluginStore.getState().registerCommand({
      id: "test.command",
      label: "Test",
      execute: () => {
        ran = true;
      },
    });

    await installMenuCommandListener();
    emitMockEvent("menu-command", "test.command");
    await Promise.resolve();

    expect(ran).toBe(true);
  });

  test("reports an unregistered id instead of failing silently", async () => {
    await installMenuCommandListener();
    emitMockEvent("menu-command", "does.not.exist");
    await Promise.resolve();

    const output = useIdeStore.getState().output;
    expect(output.some((l) => l.text.includes("does.not.exist"))).toBe(true);
  });

  test("reports a command that throws", async () => {
    usePluginStore.getState().registerCommand({
      id: "test.explodes",
      label: "Explodes",
      execute: () => {
        throw new Error("boom");
      },
    });

    await installMenuCommandListener();
    emitMockEvent("menu-command", "test.explodes");
    await new Promise((r) => setTimeout(r, 5));

    const output = useIdeStore.getState().output;
    expect(output.some((l) => l.text.includes("boom"))).toBe(true);
  });
});
