import { beforeEach, describe, expect, mock, test } from "bun:test";
import { invokeHandlers, resetTauriMocks } from "../__test__/tauriMock";

// Control what the updater plugin reports. Declared before the store is imported
// so the module picks up the mock.
let nextUpdate: { version: string; body?: string } | null = null;
let checkError: Error | null = null;
const opened: string[] = [];

mock.module("@tauri-apps/plugin-updater", () => ({
  check: async () => {
    if (checkError) throw checkError;
    return nextUpdate;
  },
}));

mock.module("@tauri-apps/plugin-opener", () => ({
  openUrl: async (url: string) => {
    opened.push(url);
  },
}));

const { useUpdateStore } = await import("./useUpdateStore");

const APPIMAGE = { canSelfInstall: true, reason: null, format: "appimage" };
const DEB = {
  canSelfInstall: false,
  reason: "julIDE was installed from a system package (.deb/.rpm)…",
  format: "system-package",
};

beforeEach(() => {
  resetTauriMocks();
  nextUpdate = null;
  checkError = null;
  opened.length = 0;
  useUpdateStore.setState({
    phase: "idle",
    version: "",
    notes: "",
    error: "",
    progress: null,
    capability: null,
    dismissed: false,
  });
});

describe("check", () => {
  test("reports up to date when there is no newer release", async () => {
    invokeHandlers.set("updater_install_capability", () => APPIMAGE);

    await useUpdateStore.getState().check();

    expect(useUpdateStore.getState().phase).toBe("upToDate");
  });

  test("records the available version and notes", async () => {
    invokeHandlers.set("updater_install_capability", () => APPIMAGE);
    nextUpdate = { version: "0.3.0", body: "Fixed things" };

    await useUpdateStore.getState().check();

    const s = useUpdateStore.getState();
    expect(s.phase).toBe("available");
    expect(s.version).toBe("0.3.0");
    expect(s.notes).toBe("Fixed things");
  });

  test("still reports an available update on deb/rpm, where self-install is impossible", async () => {
    // The whole point of splitting notify from install: .deb users should learn a
    // new version exists even though the updater cannot replace their install.
    invokeHandlers.set("updater_install_capability", () => DEB);
    nextUpdate = { version: "0.3.0" };

    await useUpdateStore.getState().check();

    const s = useUpdateStore.getState();
    expect(s.phase).toBe("available");
    expect(s.capability?.canSelfInstall).toBe(false);
    expect(s.capability?.reason).toBeTruthy();
  });

  test("a silent check swallows failures and stays idle", async () => {
    invokeHandlers.set("updater_install_capability", () => APPIMAGE);
    checkError = new Error("network unreachable");

    await useUpdateStore.getState().check({ silent: true });

    const s = useUpdateStore.getState();
    expect(s.phase).toBe("idle");
    expect(s.error).toBe("");
  });

  test("an explicit check surfaces failures", async () => {
    invokeHandlers.set("updater_install_capability", () => APPIMAGE);
    checkError = new Error("network unreachable");

    await useUpdateStore.getState().check();

    const s = useUpdateStore.getState();
    expect(s.phase).toBe("error");
    expect(s.error).toContain("network unreachable");
  });

  test("clears the dismissal so a newer version notifies again", async () => {
    invokeHandlers.set("updater_install_capability", () => APPIMAGE);
    useUpdateStore.setState({ dismissed: true });
    nextUpdate = { version: "0.4.0" };

    await useUpdateStore.getState().check();

    expect(useUpdateStore.getState().dismissed).toBe(false);
  });
});

describe("downloadAndInstall", () => {
  test("falls back to the releases page when self-install is unavailable", async () => {
    invokeHandlers.set("updater_install_capability", () => DEB);
    nextUpdate = { version: "0.3.0" };
    await useUpdateStore.getState().check();

    await useUpdateStore.getState().downloadAndInstall();

    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain("/releases/latest");
    // It must not pretend to install.
    expect(useUpdateStore.getState().phase).toBe("available");
  });

  test("does nothing when no update was found", async () => {
    invokeHandlers.set("updater_install_capability", () => APPIMAGE);
    await useUpdateStore.getState().check();

    await useUpdateStore.getState().downloadAndInstall();

    expect(opened).toHaveLength(0);
    expect(useUpdateStore.getState().phase).toBe("upToDate");
  });
});

describe("dismiss", () => {
  test("hides the banner without changing the update state", async () => {
    invokeHandlers.set("updater_install_capability", () => APPIMAGE);
    nextUpdate = { version: "0.3.0" };
    await useUpdateStore.getState().check();

    useUpdateStore.getState().dismiss();

    expect(useUpdateStore.getState().dismissed).toBe(true);
    expect(useUpdateStore.getState().phase).toBe("available");
  });
});
