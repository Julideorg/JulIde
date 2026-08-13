import { describe, expect, test } from "bun:test";
import { lspEmptyState } from "./lspEmptyState";

describe("lspEmptyState", () => {
  test("says so when the server is running and found nothing", () => {
    const empty = lspEmptyState("ready", null, "fatou", true);
    expect(empty.kind).toBe("ready");
    expect(empty.title).toBe("No problems found");
    expect(empty.hint).toContain("Fatou");
    expect(empty.action).toBeNull();
  });

  /**
   * The regression this whole change exists for. `off`, `starting` and `error`
   * all rendered "Waiting for the language server", so a language server that
   * had already given up was indistinguishable from one a second from ready —
   * and on Windows, where there is no console and no log file, that string was
   * the entire bug report.
   */
  test("an error is not a wait, and carries the server's own words", () => {
    const empty = lspEmptyState("error", "initialize timed out after 30s", "fatou", true);
    expect(empty.kind).toBe("error");
    expect(empty.title).not.toContain("Waiting");
    expect(empty.hint).toBe("initialize timed out after 30s");
    expect(empty.action).toEqual({ command: "lsp.restart", label: "Restart language server" });
  });

  /** ASCII mode folds julIDE's text and nothing else — the server's included. */
  test("marks the server's message as not ours to fold", () => {
    expect(lspEmptyState("error", "Fatou exited unexpectedly", "fatou", true).hintIsOurs).toBe(
      false,
    );
    // Our own fallback, when the backend died without saying anything.
    expect(lspEmptyState("error", null, "fatou", true).hintIsOurs).toBe(true);
  });

  /**
   * A first run on a clean install: no folder has been opened, so App.tsx never
   * calls `lsp_start` and nothing is coming. Telling the user to wait for it was
   * how "nothing to do here yet" read as "something is broken".
   */
  test("no folder open is a state of its own, with the way out", () => {
    const empty = lspEmptyState("off", null, "fatou", false);
    expect(empty.kind).toBe("no-workspace");
    expect(empty.action).toEqual({ command: "file.open-folder", label: "Open Folder" });
  });

  test("still waits when a folder is open and the server is coming up", () => {
    for (const status of ["off", "starting"]) {
      const empty = lspEmptyState(status, null, "fatou", true);
      expect(empty.kind).toBe("waiting");
      expect(empty.title).toBe("Waiting for the language server");
      expect(empty.action).toBeNull();
    }
  });

  test("names whichever backend is configured", () => {
    expect(lspEmptyState("ready", null, "languageserver", true).hint).toContain(
      "LanguageServer.jl",
    );
    expect(lspEmptyState("ready", null, "jetls", true).hint).toContain("JETLS.jl");
    // A backend id from a newer settings file than this build knows about.
    expect(lspEmptyState("ready", null, "something-new", true).hint).toContain(
      "the language server",
    );
  });

  /** Titles are julIDE's own text, so ASCII mode has to be able to fold them. */
  test("every title is plain ASCII", () => {
    for (const [status, workspace] of [
      ["ready", true],
      ["error", true],
      ["off", false],
      ["starting", true],
    ] as const) {
      const { title } = lspEmptyState(status, null, "fatou", workspace);
      // eslint-disable-next-line no-control-regex
      expect(title).toMatch(/^[\x20-\x7e]*$/);
    }
  });
});
