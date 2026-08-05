import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

export interface LifecycleCommand {
  /** The devcontainer.json key, e.g. `initializeCommand`. */
  phase: string;
  command: string;
  /** True when this runs on the host rather than inside the container. */
  runsOnHost: boolean;
}

export interface TrustStatus {
  trusted: boolean;
  commands: LifecycleCommand[];
  hasHostCommands: boolean;
}

export interface PendingTrustPrompt {
  workspacePath: string;
  status: TrustStatus;
  resolve: (approved: boolean) => void;
}

interface TrustStore {
  pending: PendingTrustPrompt | null;
  requestTrust: (workspacePath: string, status: TrustStatus) => Promise<boolean>;
  resolve: (approved: boolean) => void;
}

/**
 * Holds the pending workspace-trust prompt.
 *
 * Only one can be outstanding at a time — a dev container is started by an explicit
 * user action, so there is no queue to manage the way there is for plugin consent.
 */
export const useTrustStore = create<TrustStore>()(
  immer((set, get) => ({
    pending: null,

    requestTrust: (workspacePath, status) =>
      new Promise<boolean>((resolve) => {
        set((s) => {
          s.pending = { workspacePath, status, resolve };
        });
      }),

    resolve: (approved) => {
      const pending = get().pending;
      if (!pending) return;
      set((s) => {
        s.pending = null;
      });
      pending.resolve(approved);
    },
  })),
);
