import { describe, expect, test } from "bun:test";
import { connectSrc, describeOrigins, parseNetworkOrigins } from "./network";

const allowedOf = (raw: string[]) => parseNetworkOrigins(raw).allowed;
const reasonFor = (entry: string) => parseNetworkOrigins([entry]).rejected[0]?.reason ?? "";

describe("parseNetworkOrigins", () => {
  test("accepts plain https origins", () => {
    expect(allowedOf(["https://api.github.com"])).toEqual(["https://api.github.com"]);
  });

  test("accepts an explicit port and keeps it", () => {
    // A port is part of the origin, so it genuinely narrows the grant.
    expect(allowedOf(["https://api.example.com:8443"])).toEqual(["https://api.example.com:8443"]);
  });

  test("normalises and deduplicates", () => {
    expect(allowedOf(["https://API.example.com/", "https://api.example.com"])).toEqual([
      "https://api.example.com",
    ]);
  });

  test("no declaration means no egress, not inherited egress", () => {
    expect(parseNetworkOrigins(undefined).allowed).toEqual([]);
    expect(parseNetworkOrigins([]).allowed).toEqual([]);
    expect(connectSrc(parseNetworkOrigins(undefined))).toBe("'none'");
  });
});

describe("what a hostile manifest would like accepted", () => {
  test("wildcards are refused", () => {
    // A subdomain wildcard is only as trustworthy as that domain's worst subdomain,
    // and nobody reviewing the manifest can tell what it will resolve to later.
    expect(allowedOf(["https://*.example.com"])).toEqual([]);
    expect(reasonFor("https://*.example.com")).toContain("wildcard");
  });

  test("a bare scheme is refused", () => {
    // `https:` is every host on the internet, written to look like a restriction.
    expect(allowedOf(["https:"])).toEqual([]);
    expect(allowedOf(["https://"])).toEqual([]);
  });

  test("plain http is refused except on loopback", () => {
    expect(allowedOf(["http://api.example.com"])).toEqual([]);
    expect(reasonFor("http://api.example.com")).toContain("localhost");

    // A local language server or notebook process is a legitimate case, and the
    // traffic never leaves the machine.
    expect(allowedOf(["http://localhost:8080"])).toEqual(["http://localhost:8080"]);
    expect(allowedOf(["http://127.0.0.1:9000"])).toEqual(["http://127.0.0.1:9000"]);
  });

  test("credentials in the URL are refused", () => {
    expect(allowedOf(["https://user:pass@api.example.com"])).toEqual([]);
    expect(reasonFor("https://user:pass@api.example.com")).toContain("credentials");
  });

  test("a path or query is refused rather than silently trimmed", () => {
    // connect-src matches on origin, so a path is ignored by the browser while
    // reading, to a human, like a limit that was applied. Trimming it silently would
    // grant more than the manifest appears to ask for.
    expect(allowedOf(["https://api.example.com/v1/only"])).toEqual([]);
    expect(allowedOf(["https://api.example.com/?scope=read"])).toEqual([]);
    expect(allowedOf(["https://api.example.com/#frag"])).toEqual([]);
    expect(reasonFor("https://api.example.com/v1")).toContain("bare origin");
  });

  test("non-egress schemes are refused", () => {
    for (const v of ["data:text/plain,x", "blob:https://x/y", "file:///etc/passwd", "ws://x.com"]) {
      expect(allowedOf([v]), v).toEqual([]);
    }
  });

  test("javascript: is refused", () => {
    expect(allowedOf(["javascript:alert(1)"])).toEqual([]);
  });

  test("garbage is refused with a reason rather than throwing", () => {
    expect(allowedOf(["not a url", "", "   "])).toEqual([]);
    expect(reasonFor("not a url")).toContain("valid absolute URL");
  });

  test("the origin count is capped", () => {
    const many = Array.from({ length: 30 }, (_, i) => `https://h${i}.example.com`);
    const policy = parseNetworkOrigins(many);
    expect(policy.allowed).toHaveLength(16);
    expect(policy.rejected.length).toBe(14);
  });

  test("one bad entry does not discard the good ones", () => {
    // The consent dialog reports what was dropped; it should not be all-or-nothing.
    const policy = parseNetworkOrigins(["https://good.example.com", "https://*.bad.example.com"]);
    expect(policy.allowed).toEqual(["https://good.example.com"]);
    expect(policy.rejected).toHaveLength(1);
  });
});

describe("connectSrc", () => {
  test("joins multiple origins", () => {
    const policy = parseNetworkOrigins(["https://a.example.com", "https://b.example.com"]);
    expect(connectSrc(policy)).toBe("https://a.example.com https://b.example.com");
  });

  test("never emits a value that could widen the frame's egress", () => {
    // Belt and braces on the whole module: whatever a manifest says, the emitted
    // directive must not contain a wildcard or a bare scheme.
    const policy = parseNetworkOrigins(["https://*", "*", "https:", "'unsafe-inline'", "data:"]);
    expect(connectSrc(policy)).toBe("'none'");
  });
});

describe("describeOrigins", () => {
  test("shows hosts without scheme noise for the consent dialog", () => {
    const policy = parseNetworkOrigins(["https://api.github.com", "https://x.example.com:8443"]);
    expect(describeOrigins(policy)).toEqual(["api.github.com", "x.example.com:8443"]);
  });
});
