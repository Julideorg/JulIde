import { describe, expect, test } from "bun:test";
import { isMarkdownPath, renderMarkdownUnsafe, slugify } from "./renderer";

/**
 * These run against the *unsanitized* parser output on purpose.
 *
 * `bun test` has no DOM, so DOMPurify is not available and `renderMarkdown` would fall
 * back to escaping everything — testing through it would prove nothing about either
 * layer. What is verified here is the parser's own escaping, which is the primary
 * defense and needs no DOM. See sanitize.test.ts for the rest.
 */

describe("structure", () => {
  test("headings, emphasis and lists render", () => {
    const html = renderMarkdownUnsafe("# Title\n\nSome **bold** text.\n\n- one\n- two");
    expect(html).toContain("<h1");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<li>one</li>");
  });

  test("GFM tables render", () => {
    const html = renderMarkdownUnsafe("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
  });

  test("fenced code carries the language as a class, so Julia can be highlighted later", () => {
    const html = renderMarkdownUnsafe("```julia\nf(x) = x^2\n```");
    expect(html).toContain('<code class="language-julia">');
    expect(html).toContain("f(x) = x^2");
  });

  test("task lists avoid <input>, which the sanitizer allowlist would strip", () => {
    const html = renderMarkdownUnsafe("- [ ] todo\n- [x] done");
    expect(html).not.toContain("<input");
    expect(html).toContain("md-task");
    expect(html).toContain("md-task--done");
  });

  test("strikethrough works, so GFM is genuinely on", () => {
    expect(renderMarkdownUnsafe("~~gone~~")).toContain("<del>gone</del>");
  });
});

describe("raw HTML is inert", () => {
  // marked has no `html: false` option — passthrough is disabled by overriding the html
  // renderer. These are the tests that would catch that override being dropped.
  test("a block-level script tag comes out as text", () => {
    const html = renderMarkdownUnsafe("<script>alert(1)</script>");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });

  test("an inline img with an onerror handler comes out as text", () => {
    const html = renderMarkdownUnsafe("Hello <img src=x onerror=alert(1)>.");
    // The handler's characters survive as *text* — what matters is that no tag is
    // produced, so there is no element for an attribute to attach to.
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&gt;");
  });

  test("authored block HTML is shown rather than rendered", () => {
    const html = renderMarkdownUnsafe("<details><summary>x</summary>y</details>");
    expect(html).not.toContain("<details>");
    expect(html).toContain("&lt;details&gt;");
  });
});

describe("links", () => {
  test("http links become anchors with rel set", () => {
    const html = renderMarkdownUnsafe("[julia](https://julialang.org)");
    expect(html).toContain('href="https://julialang.org"');
    expect(html).toContain('rel="noreferrer noopener"');
  });

  test("relative links survive as written, for the click handler to resolve", () => {
    expect(renderMarkdownUnsafe("[guide](./docs/a.md#usage)")).toContain(
      'href="./docs/a.md#usage"',
    );
  });

  test("a javascript: link never becomes an anchor at all", () => {
    const html = renderMarkdownUnsafe("[click](javascript:alert(1))");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click");
  });

  test("case and whitespace obfuscation does not smuggle a scheme through", () => {
    for (const href of ["JaVaScRiPt:alert(1)", "  javascript:alert(1)", "vbscript:x"]) {
      const html = renderMarkdownUnsafe(`[x](${href})`);
      expect(html).not.toContain("<a ");
    }
  });

  test("a data: URL is refused too", () => {
    const html = renderMarkdownUnsafe("[x](data:text/html;base64,PHNjcmlwdD4=)");
    expect(html).not.toContain("<a ");
  });
});

describe("images (default: blocked)", () => {
  test("no <img> is ever emitted — the preview decides, not the document", () => {
    const html = renderMarkdownUnsafe("![a diagram](./diagram.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain("md-img-missing");
  });

  test("the placeholder keeps the alt text and the source", () => {
    const html = renderMarkdownUnsafe("![a diagram](./diagram.png)");
    expect(html).toContain("a diagram");
    expect(html).toContain('data-md-src="./diagram.png"');
  });

  test("remote images get the same treatment", () => {
    expect(renderMarkdownUnsafe("![badge](https://img.shields.io/x.svg)")).toContain(
      "md-img-missing",
    );
  });

  test("an image with no alt text still renders a placeholder", () => {
    expect(renderMarkdownUnsafe("![](./x.png)")).toContain("md-img-missing");
  });
});

describe('images with { images: "resolvable" }', () => {
  const R = { images: "resolvable" } as const;

  test("still emits no <img> — the element is created after sanitization", () => {
    // This is what lets `img` stay in FORBID_TAGS and `src` in FORBID_ATTR.
    const html = renderMarkdownUnsafe("![a diagram](./diagram.png)", R);
    expect(html).not.toContain("<img");
    expect(html).not.toContain(" src=");
    expect(html).toContain('<span class="md-img" data-md-src="./diagram.png">a diagram</span>');
  });

  test("the class changes, so the resolver finds only these", () => {
    const html = renderMarkdownUnsafe("![a](./x.png)", R);
    expect(html).toContain('class="md-img"');
    expect(html).not.toContain("md-img-missing");
  });

  test("a remote image gets the same span; the scheme is judged at resolve time", () => {
    expect(renderMarkdownUnsafe("![badge](https://img.shields.io/x.svg)", R)).toContain(
      'data-md-src="https://img.shields.io/x.svg"',
    );
  });

  test("a query string survives the round trip through the attribute", () => {
    // Badge URLs carry them, and &amp; must decode back to & via getAttribute.
    const html = renderMarkdownUnsafe("![b](https://img.shields.io/x?a=1&b=2)", R);
    expect(html).toContain('data-md-src="https://img.shields.io/x?a=1&amp;b=2"');
  });

  test("an image with no alt text yields an empty span", () => {
    expect(renderMarkdownUnsafe("![](./x.png)", R)).toContain(
      '<span class="md-img" data-md-src="./x.png"></span>',
    );
  });

  test("alt text cannot break out of the span", () => {
    const html = renderMarkdownUnsafe('![" onerror="alert(1)](./x.png)', R);
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain("&quot;");
  });

  test("a hostile src is carried inertly, for the resolver to refuse", () => {
    // data-md-src is not a URI attribute, so ALLOWED_URI_REGEXP does not apply to it.
    // classifyImageSrc is what refuses this, and it is tested there.
    const html = renderMarkdownUnsafe("![x](javascript:alert(1))", R);
    expect(html).not.toContain("<img");
    expect(html).toContain('data-md-src="javascript:alert(1)"');
  });

  test("resolvable mode changes nothing else about the document", () => {
    // The option must be a switch on one renderer and nothing else.
    const src = "# T\n\n[l](https://x.dev)\n\n- [x] done\n\n<script>alert(1)</script>";
    expect(renderMarkdownUnsafe(src, R)).toBe(renderMarkdownUnsafe(src));
  });
});

describe("heading ids", () => {
  test("headings get slugged ids so #anchor links resolve", () => {
    expect(renderMarkdownUnsafe("## Getting Started")).toContain('id="getting-started"');
  });

  test("punctuation and case are dropped from the slug", () => {
    expect(renderMarkdownUnsafe("## What's New?!")).toContain('id="whats-new"');
  });

  test("duplicate headings are disambiguated rather than colliding", () => {
    const html = renderMarkdownUnsafe("## Usage\n\n## Usage\n\n## Usage");
    expect(html).toContain('id="usage"');
    expect(html).toContain('id="usage-1"');
    expect(html).toContain('id="usage-2"');
  });

  test("slug state does not leak between documents", () => {
    renderMarkdownUnsafe("## Usage");
    expect(renderMarkdownUnsafe("## Usage")).toContain('id="usage"');
  });

  test("inline markup in a heading is stripped from the id but kept in the text", () => {
    const html = renderMarkdownUnsafe("## Using `Plots.jl`");
    expect(html).toContain('id="using-plotsjl"');
    expect(html).toContain("<code>Plots.jl</code>");
  });
});

describe("slugify", () => {
  test("lowercases, strips punctuation and hyphenates", () => {
    expect(slugify("Getting Started!")).toBe("getting-started");
    expect(slugify("  Spaced   Out  ")).toBe("spaced-out");
  });
});

describe("isMarkdownPath", () => {
  test("accepts the usual markdown extensions, case-insensitively", () => {
    for (const p of ["/a/README.md", "notes.markdown", "x.MD", "y.mkd", "z.mdown"]) {
      expect(isMarkdownPath(p)).toBe(true);
    }
  });

  test("rejects everything else", () => {
    for (const p of ["/a/main.jl", "Project.toml", "README", "a.md.jl"]) {
      expect(isMarkdownPath(p)).toBe(false);
    }
  });
});
