import { describe, expect, test, beforeEach } from "bun:test";
import { useSettingsStore } from "./useSettingsStore";
import { resetAllStores } from "../__test__/storeTestUtils";
import { invokeHandlers } from "../__test__/tauriMock";

beforeEach(() => {
  resetAllStores();
});

describe("initial state", () => {
  test("has correct defaults", () => {
    const { settings } = useSettingsStore.getState();
    expect(settings.fontSize).toBe(14);
    expect(settings.tabSize).toBe(4);
    expect(settings.theme).toBe("julide-dark");
    expect(settings.minimapEnabled).toBe(true);
    expect(settings.wordWrap).toBe("off");
    // Off for a fresh install, so an unsaved file stays visibly unsaved. An install
    // that already stored `autoSave: true` keeps it, since settings_save writes
    // every field and loadSettings merges what is on disk over these defaults.
    expect(settings.autoSave).toBe(false);
    expect(settings.terminalFontSize).toBe(13);
    expect(settings.containerRuntime).toBe("auto");
    expect(settings.plutoPort).toBe(3000);
    expect(settings.recentWorkspaces).toEqual([]);
    // The image escape hatches are opt-in; a default flip would silently start
    // reading files and making network requests on behalf of every existing user.
    expect(settings.allowLocalImages).toBe(false);
    expect(settings.allowRemoteImages).toBe(false);
    expect(settings.uiZoom).toBe(1);
    // Opt-in: turning it on for everyone would rewrite the interface of every existing
    // install to fix a complaint only some users have.
    expect(settings.asciiOnly).toBe(false);
  });

  test("loaded is false initially", () => {
    expect(useSettingsStore.getState().loaded).toBe(false);
  });
});

describe("loadSettings", () => {
  test("merges partial response from invoke", async () => {
    invokeHandlers.set("settings_load", () => ({
      fontSize: 18,
      theme: "julide-light",
    }));

    await useSettingsStore.getState().loadSettings();

    const { settings, loaded } = useSettingsStore.getState();
    expect(loaded).toBe(true);
    expect(settings.fontSize).toBe(18);
    expect(settings.theme).toBe("julide-light");
    // Unset fields keep defaults
    expect(settings.tabSize).toBe(4);
    expect(settings.minimapEnabled).toBe(true);
  });

  test("on failure, sets loaded but keeps defaults", async () => {
    invokeHandlers.set("settings_load", () => {
      throw new Error("disk error");
    });

    await useSettingsStore.getState().loadSettings();

    const { settings, loaded } = useSettingsStore.getState();
    expect(loaded).toBe(true);
    expect(settings.fontSize).toBe(14); // default
  });
});

describe("updateSettings", () => {
  test("updates in-memory settings immediately", async () => {
    invokeHandlers.set("settings_save", () => undefined);

    await useSettingsStore.getState().updateSettings({ fontSize: 20 });

    // The in-memory value must be live at once — only the disk write is deferred.
    expect(useSettingsStore.getState().settings.fontSize).toBe(20);
  });

  test("persists after the debounce elapses", async () => {
    let savedSettings: any = null;
    invokeHandlers.set("settings_save", (args: any) => {
      savedSettings = args?.settings;
    });

    await useSettingsStore.getState().updateSettings({ fontSize: 20 });
    expect(savedSettings).toBeNull();

    await new Promise((r) => setTimeout(r, 400));
    expect(savedSettings).not.toBeNull();
    expect(savedSettings.fontSize).toBe(20);
  });

  test("coalesces a burst of edits into one write", async () => {
    // The settings panel calls updateSettings on every keystroke; typing a font
    // family used to mean ~20 disk writes and IPC round-trips.
    let saveCount = 0;
    invokeHandlers.set("settings_save", () => {
      saveCount++;
    });

    for (const size of [15, 16, 17, 18, 19, 20]) {
      await useSettingsStore.getState().updateSettings({ fontSize: size });
    }

    await new Promise((r) => setTimeout(r, 400));
    expect(saveCount).toBe(1);
    expect(useSettingsStore.getState().settings.fontSize).toBe(20);
  });

  test("flushSettings writes without waiting for the debounce", async () => {
    let savedSettings: any = null;
    invokeHandlers.set("settings_save", (args: any) => {
      savedSettings = args?.settings;
    });

    await useSettingsStore.getState().updateSettings({ tabSize: 8 });
    await useSettingsStore.getState().flushSettings();

    expect(savedSettings).not.toBeNull();
    expect(savedSettings.tabSize).toBe(8);
  });

  test("records a save failure instead of swallowing it", async () => {
    // A read-only config dir used to silently discard every preference.
    invokeHandlers.set("settings_save", () => {
      throw new Error("permission denied");
    });

    await useSettingsStore.getState().updateSettings({ fontSize: 20 });
    await useSettingsStore.getState().flushSettings();

    expect(useSettingsStore.getState().saveError).toContain("permission denied");
  });

  test("clears the save error once a later write succeeds", async () => {
    invokeHandlers.set("settings_save", () => {
      throw new Error("permission denied");
    });
    await useSettingsStore.getState().updateSettings({ fontSize: 20 });
    await useSettingsStore.getState().flushSettings();
    expect(useSettingsStore.getState().saveError).not.toBe("");

    invokeHandlers.set("settings_save", () => undefined);
    await useSettingsStore.getState().updateSettings({ fontSize: 21 });
    await useSettingsStore.getState().flushSettings();
    expect(useSettingsStore.getState().saveError).toBe("");
  });
});

describe("resetSettings", () => {
  test("restores defaults but keeps recent workspaces", async () => {
    invokeHandlers.set("settings_save", () => undefined);

    await useSettingsStore.getState().updateSettings({
      fontSize: 30,
      theme: "julide-light",
      recentWorkspaces: ["/a", "/b"],
    });

    await useSettingsStore.getState().resetSettings();

    const s = useSettingsStore.getState().settings;
    expect(s.fontSize).toBe(14);
    expect(s.theme).toBe("julide-dark");
    // Recents are history, not a preference — resetting must not erase them.
    expect(s.recentWorkspaces).toEqual(["/a", "/b"]);
  });
});

describe("setSettingsOpen", () => {
  test("toggles settingsOpen", () => {
    useSettingsStore.getState().setSettingsOpen(true);
    expect(useSettingsStore.getState().settingsOpen).toBe(true);

    useSettingsStore.getState().setSettingsOpen(false);
    expect(useSettingsStore.getState().settingsOpen).toBe(false);
  });
});
