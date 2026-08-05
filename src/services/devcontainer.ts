import { invoke } from "@tauri-apps/api/core";
import { useTrustStore, type TrustStatus } from "../stores/useTrustStore";

/**
 * Ensure the user has approved this workspace's devcontainer lifecycle commands.
 *
 * A `devcontainer.json` can declare `initializeCommand`, which the devcontainer spec
 * runs on the **host** — so opening a repo someone else wrote and clicking "start dev
 * container" would otherwise execute their shell commands on this machine with no
 * warning. This is the prompt.
 *
 * The backend enforces the same check independently (see `src-tauri/src/trust.rs`);
 * this exists so the user gets a reviewable dialog rather than a bare error, not as
 * the security boundary itself.
 *
 * Returns false if the user declined, in which case the caller must not proceed.
 */
export async function ensureDevcontainerTrusted(workspacePath: string): Promise<boolean> {
  const status = await invoke<TrustStatus>("devcontainer_trust_status", { workspacePath });
  if (status.trusted) return true;

  const approved = await useTrustStore.getState().requestTrust(workspacePath, status);
  if (!approved) return false;

  await invoke("devcontainer_trust_grant", { workspacePath });
  return true;
}

export interface DevcontainerOptions {
  displayForwarding: boolean;
  gpuPassthrough: boolean;
  selinuxLabel: boolean;
  persistJuliaPackages: boolean;
}

/**
 * Start (or rebuild) the dev container, prompting for trust first.
 *
 * Returns false when the user declined — callers should treat that as a no-op, not
 * an error, since declining is a legitimate choice rather than a failure.
 */
export async function startDevcontainer(
  workspacePath: string,
  options: DevcontainerOptions,
  mode: "up" | "rebuild" = "up",
): Promise<boolean> {
  if (!(await ensureDevcontainerTrusted(workspacePath))) return false;

  await invoke(mode === "up" ? "devcontainer_up" : "devcontainer_rebuild", {
    workspacePath,
    ...options,
  });
  return true;
}
