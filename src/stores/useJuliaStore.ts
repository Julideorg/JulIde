import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "./useSettingsStore";

export type JuliaDetectionStatus = "unknown" | "detecting" | "found" | "missing";

interface JuliaStore {
  status: JuliaDetectionStatus;
  /** Raw `julia --version` output when found, otherwise the failure reason. */
  version: string;
  error: string;
  /** True while the setup dialog is open. */
  setupOpen: boolean;

  detect: () => Promise<void>;
  setSetupOpen: (open: boolean) => void;
  /** Open a native picker, validate the choice, and persist it. */
  locateManually: () => Promise<void>;
  /** Point Julia at an explicit path (validated by the backend). */
  setPath: (path: string) => Promise<void>;
}

/**
 * Single source of truth for "do we have a working Julia?".
 *
 * The welcome screen and the status bar each used to probe `julia_get_version`
 * independently and render the bare string "Julia not found" with no way to act on
 * it. Centralising the state lets both surfaces share one detection result and lets
 * the setup dialog re-run detection after the user fixes the problem.
 */
export const useJuliaStore = create<JuliaStore>()(
  immer((set, get) => ({
    status: "unknown",
    version: "",
    error: "",
    setupOpen: false,

    setSetupOpen: (open) =>
      set((s) => {
        s.setupOpen = open;
      }),

    detect: async () => {
      set((s) => {
        s.status = "detecting";
      });
      try {
        const version = await invoke<string>("julia_get_version");
        set((s) => {
          s.status = "found";
          s.version = version;
          s.error = "";
        });
      } catch (e) {
        set((s) => {
          s.status = "missing";
          s.version = "";
          s.error = e instanceof Error ? e.message : String(e);
        });
      }
    },

    setPath: async (path: string) => {
      // julia_set_path probes the binary with --version and rejects anything that
      // does not identify itself as Julia, so a bad pick surfaces here rather than
      // failing later on every run.
      await invoke("julia_set_path", { path });
      await useSettingsStore.getState().updateSettings({ juliaPath: path });
      await get().detect();
    },

    locateManually: async () => {
      const path = await invoke<string | null>("dialog_pick_executable");
      if (!path) return;
      await get().setPath(path);
    },
  })),
);
