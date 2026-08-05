import { beforeEach, describe, expect, test } from "bun:test";
import { useJuliaStore } from "./useJuliaStore";
import { useSettingsStore } from "./useSettingsStore";
import { invokeHandlers, resetTauriMocks } from "../__test__/tauriMock";

function resetJuliaStore() {
  useJuliaStore.setState({
    status: "unknown",
    version: "",
    error: "",
    setupOpen: false,
  });
}

describe("useJuliaStore", () => {
  beforeEach(() => {
    resetTauriMocks();
    resetJuliaStore();
  });

  test("detect() records the version when Julia is present", async () => {
    invokeHandlers.set("julia_get_version", () => "julia version 1.12.6");

    await useJuliaStore.getState().detect();

    const s = useJuliaStore.getState();
    expect(s.status).toBe("found");
    expect(s.version).toBe("julia version 1.12.6");
    expect(s.error).toBe("");
  });

  test("detect() records missing status and the reason when Julia is absent", async () => {
    invokeHandlers.set("julia_get_version", () => {
      throw new Error("Julia not found. Install Julia or set JULIA_PATH.");
    });

    await useJuliaStore.getState().detect();

    const s = useJuliaStore.getState();
    expect(s.status).toBe("missing");
    expect(s.version).toBe("");
    expect(s.error).toContain("Julia not found");
  });

  test("setPath() persists the setting and re-detects", async () => {
    const setPathCalls: unknown[] = [];
    invokeHandlers.set("julia_set_path", (args) => {
      setPathCalls.push(args);
    });
    invokeHandlers.set("settings_save", () => undefined);
    invokeHandlers.set("julia_get_version", () => "julia version 1.12.6");

    await useJuliaStore.getState().setPath("/opt/julia/bin/julia");

    expect(setPathCalls).toEqual([{ path: "/opt/julia/bin/julia" }]);
    expect(useSettingsStore.getState().settings.juliaPath).toBe("/opt/julia/bin/julia");
    expect(useJuliaStore.getState().status).toBe("found");
  });

  test("setPath() propagates a rejected binary and leaves the setting alone", async () => {
    // The backend probes the binary with --version; a non-Julia pick must surface
    // here rather than silently becoming the configured interpreter.
    invokeHandlers.set("julia_set_path", () => {
      throw new Error("/bin/ls does not report itself as Julia");
    });

    await expect(useJuliaStore.getState().setPath("/bin/ls")).rejects.toThrow(
      /does not report itself as Julia/,
    );
    expect(useSettingsStore.getState().settings.juliaPath).not.toBe("/bin/ls");
  });

  test("locateManually() does nothing when the picker is cancelled", async () => {
    let setPathCalled = false;
    invokeHandlers.set("dialog_pick_executable", () => null);
    invokeHandlers.set("julia_set_path", () => {
      setPathCalled = true;
    });

    await useJuliaStore.getState().locateManually();

    expect(setPathCalled).toBe(false);
    expect(useJuliaStore.getState().status).toBe("unknown");
  });

  test("setSetupOpen() toggles dialog visibility", () => {
    expect(useJuliaStore.getState().setupOpen).toBe(false);
    useJuliaStore.getState().setSetupOpen(true);
    expect(useJuliaStore.getState().setupOpen).toBe(true);
  });
});
