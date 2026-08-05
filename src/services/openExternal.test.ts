import { beforeEach, describe, expect, mock, test } from "bun:test";

const opened: string[] = [];

// Override the global plugin-opener mock from src/__test__/setup.ts so we can
// assert on exactly which URLs reach the OS handler.
mock.module("@tauri-apps/plugin-opener", () => ({
  openUrl: async (url: string) => {
    opened.push(url);
  },
}));

const { openExternal } = await import("./openExternal");

describe("openExternal", () => {
  beforeEach(() => {
    opened.length = 0;
  });

  test("opens https URLs", async () => {
    await openExternal("https://github.com/sinisterMage/julide/pull/1");
    expect(opened).toEqual(["https://github.com/sinisterMage/julide/pull/1"]);
  });

  test("opens http URLs", async () => {
    // Self-hosted Gitea over plain HTTP on a LAN is legitimate for *browsing*;
    // it is only the API/token path that forces https.
    await openExternal("http://gitea.internal/owner/repo/issues/3");
    expect(opened).toEqual(["http://gitea.internal/owner/repo/issues/3"]);
  });

  test("refuses file:// URLs without opening anything", async () => {
    await expect(openExternal("file:///etc/passwd")).rejects.toThrow(/non-http/);
    expect(opened).toEqual([]);
  });

  test("refuses custom schemes", async () => {
    // A hostile or compromised provider instance can put anything in `url`.
    await expect(openExternal("javascript:alert(1)")).rejects.toThrow(/non-http/);
    await expect(openExternal("vscode://foo/bar")).rejects.toThrow(/non-http/);
    expect(opened).toEqual([]);
  });

  test("refuses malformed URLs", async () => {
    await expect(openExternal("not a url")).rejects.toThrow(/malformed/);
    expect(opened).toEqual([]);
  });
});
