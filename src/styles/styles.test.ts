import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards for the stylesheet layer.
 *
 * The pre-redesign App.css referenced `var(--red)` and `var(--accent-purple)`,
 * neither of which was ever defined — both silently rendered their fallback
 * hex forever and ignored the theme. Nothing caught it because a bad var()
 * reference is not a CSS error. These tests catch it.
 */

const DIR = join(import.meta.dir);
const files = readdirSync(DIR).filter((f) => f.endsWith(".css"));
const read = (f: string) => readFileSync(join(DIR, f), "utf8");

/** Injected at runtime by App.tsx as an inline style on .ide-root. */
const RUNTIME_VARS = new Set(["--sidebar-width"]);

describe("stylesheets", () => {
  test("every referenced custom property is defined somewhere", () => {
    // Definitions are collected from every stylesheet, not just tokens.css:
    // components may declare locally-scoped properties of their own (ui.css
    // sets --tone on .ui-tone so variants can stay tone-agnostic). What must
    // never happen is a reference to a property defined *nowhere*.
    const defined = new Set(
      files.flatMap((f) => [...read(f).matchAll(/^\s+(--[a-z0-9-]+):/gm)].map((m) => m[1])),
    );

    const undefinedRefs = new Map<string, string[]>();
    for (const file of files) {
      for (const m of read(file).matchAll(/var\((--[a-z0-9-]+)/g)) {
        const name = m[1];
        if (defined.has(name) || RUNTIME_VARS.has(name)) continue;
        if (!undefinedRefs.has(name)) undefinedRefs.set(name, []);
        if (!undefinedRefs.get(name)!.includes(file)) undefinedRefs.get(name)!.push(file);
      }
    }

    expect(Object.fromEntries(undefinedRefs)).toEqual({});
  });

  test("no stylesheet hardcodes a colour outside tokens.css", () => {
    // The stylesheet this replaced carried 43 stray hex literals and 31 ad-hoc
    // rgba() values that bypassed the variables entirely, which is why light
    // mode was broken in a dozen places: those colours simply never changed.
    const offenders: Record<string, string[]> = {};
    for (const file of files) {
      if (file === "tokens.css") continue;
      const found = read(file)
        // Ignore colours inside data: URIs — an inline SVG chevron cannot
        // reference a custom property.
        .replace(/url\("data:[^"]*"\)/g, "")
        .match(/#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/g);
      if (found) offenders[file] = [...new Set(found)];
    }
    expect(offenders).toEqual({});
  });

  test("index.css imports every stylesheet in the directory", () => {
    const imported = new Set(
      [...read("index.css").matchAll(/@import "\.\/([\w-]+\.css)"/g)].map((m) => m[1]),
    );
    const orphans = files.filter((f) => f !== "index.css" && !imported.has(f));
    expect(orphans).toEqual([]);
  });

  test("tokens.css is imported first so every later file can resolve vars", () => {
    const order = [...read("index.css").matchAll(/@import "\.\/([\w-]+\.css)"/g)].map((m) => m[1]);
    expect(order[0]).toBe("tokens.css");
  });
});
