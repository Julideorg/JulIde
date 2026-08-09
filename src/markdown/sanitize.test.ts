import { describe, expect, test } from "bun:test";
import {
  escapeHtml,
  isSanitizerAvailable,
  sanitizeMarkdown,
  MARKDOWN_ALLOWED_ATTR,
  MARKDOWN_ALLOWED_TAGS,
} from "./sanitize";

/**
 * Note what these tests deliberately do NOT do.
 *
 * There is no DOM under `bun test`, so DOMPurify is not actually instantiated and cannot
 * sanitize anything. A test like `expect(sanitizeMarkdown("<script>…")).not.toContain(
 * "<script>")` would pass here — via the escaping fallback, not via sanitization — and
 * would silently change meaning the day someone adds a DOM shim. That is worse than no
 * test at all.
 *
 * So: the allowlist is asserted as data, the fail-closed path is asserted directly, and
 * the parser's own escaping (the primary defense, and fully testable without a DOM) is
 * covered in renderer.test.ts.
 */

describe("allowlist", () => {
  test("excludes every tag that can execute, load or submit", () => {
    for (const tag of [
      "script",
      "style",
      "iframe",
      "object",
      "embed",
      "form",
      "input",
      "button",
      "img",
      "svg",
      "math",
      "link",
      "meta",
      "base",
      "template",
    ]) {
      expect(MARKDOWN_ALLOWED_TAGS).not.toContain(tag);
    }
  });

  test("includes the prose and table elements a README actually needs", () => {
    for (const tag of ["h1", "p", "ul", "li", "pre", "code", "a", "table", "thead", "td", "em"]) {
      expect(MARKDOWN_ALLOWED_TAGS).toContain(tag);
    }
  });

  test("excludes attributes that fetch, style or retarget", () => {
    for (const attr of ["src", "srcset", "style", "target", "formaction", "srcdoc", "ping"]) {
      expect(MARKDOWN_ALLOWED_ATTR).not.toContain(attr);
    }
  });

  test("carries no event handlers", () => {
    expect(MARKDOWN_ALLOWED_ATTR.filter((a) => /^on/i.test(a))).toEqual([]);
  });

  test("allows only what the renderer and stylesheet rely on", () => {
    for (const attr of ["href", "title", "id", "class", "rel"]) {
      expect(MARKDOWN_ALLOWED_ATTR).toContain(attr);
    }
  });
});

describe("fail-closed behaviour without a DOM", () => {
  test("bun has no DOM, so no sanitizer is available", () => {
    // Guards the assumption the next test rests on. If this ever flips — someone added
    // happy-dom to the preload — the fallback below stops being the live path and this
    // whole file needs revisiting.
    expect(isSanitizerAvailable()).toBe(false);
  });

  test("markup is escaped rather than passed through when the sanitizer is missing", () => {
    const out = sanitizeMarkdown("<b>hi</b>");
    expect(out).toBe("&lt;b&gt;hi&lt;/b&gt;");
    expect(out).not.toContain("<b>");
  });

  test("the fallback never yields something that could execute", () => {
    const out = sanitizeMarkdown('<script>alert(1)</script><a onclick="x()">y</a>');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<a ");
  });
});

describe("escapeHtml", () => {
  test("escapes the five characters that matter", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });

  test("escapes ampersands first, so entities are not double-decoded", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  test("leaves ordinary prose alone", () => {
    expect(escapeHtml("Plots.jl v1.40 — fast")).toBe("Plots.jl v1.40 — fast");
  });
});
