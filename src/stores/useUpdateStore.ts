import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { openExternal } from "../services/openExternal";

const RELEASES_URL = "https://github.com/sinisterMage/julide/releases/latest";

export interface InstallCapability {
  canSelfInstall: boolean;
  reason: string | null;
  format: string;
}

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "upToDate"
  | "error";

interface UpdateStore {
  phase: UpdatePhase;
  version: string;
  notes: string;
  error: string;
  /** Bytes downloaded / total, when the total is known. */
  progress: { downloaded: number; total: number | null } | null;
  capability: InstallCapability | null;
  /** Set once the user dismisses the banner for this version. */
  dismissed: boolean;

  check: (opts?: { silent?: boolean }) => Promise<void>;
  downloadAndInstall: () => Promise<void>;
  openReleasesPage: () => Promise<void>;
  dismiss: () => void;
}

/**
 * In-app update state.
 *
 * One code path, two behaviours: the check always runs, but self-install is only
 * offered when the running bundle actually supports it. `tauri-plugin-updater`
 * cannot replace a `.deb`/`.rpm` install, so those users get the release page
 * instead of a button that would fail — see src-tauri/src/updater.rs.
 */
export const useUpdateStore = create<UpdateStore>()(
  immer((set, get) => {
    // Held outside the store: the Update handle is a live object with methods, and
    // immer would freeze it.
    let pendingUpdate: Update | null = null;

    return {
      phase: "idle",
      version: "",
      notes: "",
      error: "",
      progress: null,
      capability: null,
      dismissed: false,

      check: async (opts) => {
        set((s) => {
          s.phase = "checking";
          s.error = "";
        });

        try {
          const capability = await invoke<InstallCapability>("updater_install_capability");
          set((s) => {
            s.capability = capability;
          });

          const update = await check();
          if (!update) {
            pendingUpdate = null;
            set((s) => {
              s.phase = "upToDate";
            });
            return;
          }

          pendingUpdate = update;
          set((s) => {
            s.phase = "available";
            s.version = update.version;
            s.notes = update.body ?? "";
            s.dismissed = false;
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          // A startup check must never be in the user's face. Failures here are
          // routine — no network, or the release feed is briefly unavailable.
          if (opts?.silent) {
            console.error("Update check failed:", message);
            set((s) => {
              s.phase = "idle";
            });
            return;
          }
          set((s) => {
            s.phase = "error";
            s.error = message;
          });
        }
      },

      downloadAndInstall: async () => {
        const update = pendingUpdate;
        if (!update) return;

        if (!get().capability?.canSelfInstall) {
          await get().openReleasesPage();
          return;
        }

        set((s) => {
          s.phase = "downloading";
          s.progress = { downloaded: 0, total: null };
        });

        try {
          let downloaded = 0;
          await update.downloadAndInstall((event) => {
            if (event.event === "Started") {
              set((s) => {
                s.progress = { downloaded: 0, total: event.data.contentLength ?? null };
              });
            } else if (event.event === "Progress") {
              downloaded += event.data.chunkLength;
              set((s) => {
                if (s.progress) s.progress.downloaded = downloaded;
              });
            } else if (event.event === "Finished") {
              set((s) => {
                s.phase = "ready";
              });
            }
          });

          set((s) => {
            s.phase = "ready";
          });
        } catch (e) {
          set((s) => {
            s.phase = "error";
            s.error = e instanceof Error ? e.message : String(e);
          });
        }
      },

      openReleasesPage: async () => {
        await openExternal(RELEASES_URL);
      },

      dismiss: () =>
        set((s) => {
          s.dismissed = true;
        }),
    };
  }),
);
