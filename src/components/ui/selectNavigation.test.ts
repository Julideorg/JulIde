import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  appendTypeahead,
  firstEnabledIndex,
  isTypeaheadKey,
  lastEnabledIndex,
  nextIndex,
  typeaheadIndex,
  TYPEAHEAD_RESET_MS,
  type NavOption,
} from "./selectNavigation";

const opts = (...labels: string[]): NavOption[] => labels.map((label) => ({ label }));

describe("nextIndex", () => {
  const o = opts("Off", "On", "Word Wrap Column", "Bounded");

  test("ArrowDown and ArrowUp step one at a time", () => {
    expect(nextIndex("ArrowDown", 0, o)).toBe(1);
    expect(nextIndex("ArrowUp", 2, o)).toBe(1);
  });

  test("clamps at both ends rather than wrapping", () => {
    // Native <select> parks on the last option when you hold ArrowDown; so do we.
    expect(nextIndex("ArrowDown", 3, o)).toBe(3);
    expect(nextIndex("ArrowUp", 0, o)).toBe(0);
  });

  test("Home and End jump to the extremes", () => {
    expect(nextIndex("Home", 2, o)).toBe(0);
    expect(nextIndex("End", 1, o)).toBe(3);
  });

  test("non-navigational keys return null so the caller can handle them", () => {
    expect(nextIndex("Enter", 1, o)).toBeNull();
    expect(nextIndex("a", 1, o)).toBeNull();
    expect(nextIndex("Escape", 1, o)).toBeNull();
  });

  test("skips disabled options in both directions", () => {
    const withDisabled: NavOption[] = [
      { label: "One" },
      { label: "Two", disabled: true },
      { label: "Three" },
    ];
    expect(nextIndex("ArrowDown", 0, withDisabled)).toBe(2);
    expect(nextIndex("ArrowUp", 2, withDisabled)).toBe(0);
  });

  test("Home and End skip disabled options at the extremes", () => {
    const edges: NavOption[] = [
      { label: "One", disabled: true },
      { label: "Two" },
      { label: "Three", disabled: true },
    ];
    expect(nextIndex("Home", 1, edges)).toBe(1);
    expect(nextIndex("End", 1, edges)).toBe(1);
  });

  test("an empty option list never navigates", () => {
    expect(nextIndex("ArrowDown", -1, [])).toBeNull();
    expect(nextIndex("Home", -1, [])).toBeNull();
  });

  test("stays put when every remaining option in that direction is disabled", () => {
    const tail: NavOption[] = [{ label: "One" }, { label: "Two", disabled: true }];
    expect(nextIndex("ArrowDown", 0, tail)).toBe(0);
  });
});

describe("firstEnabledIndex / lastEnabledIndex", () => {
  test("skip past disabled entries", () => {
    const o: NavOption[] = [
      { label: "One", disabled: true },
      { label: "Two" },
      { label: "Three" },
      { label: "Four", disabled: true },
    ];
    expect(firstEnabledIndex(o)).toBe(1);
    expect(lastEnabledIndex(o)).toBe(2);
  });

  test("return -1 when nothing is selectable", () => {
    const o: NavOption[] = [{ label: "One", disabled: true }];
    expect(firstEnabledIndex(o)).toBe(-1);
    expect(lastEnabledIndex(o)).toBe(-1);
    expect(firstEnabledIndex([])).toBe(-1);
  });
});

describe("isTypeaheadKey", () => {
  test("accepts single printable characters", () => {
    expect(isTypeaheadKey("a")).toBe(true);
    expect(isTypeaheadKey("Z")).toBe(true);
    expect(isTypeaheadKey("7")).toBe(true);
  });

  test("rejects named keys, and space, which commits instead", () => {
    expect(isTypeaheadKey("ArrowDown")).toBe(false);
    expect(isTypeaheadKey("Enter")).toBe(false);
    expect(isTypeaheadKey("Tab")).toBe(false);
    expect(isTypeaheadKey(" ")).toBe(false);
  });
});

describe("appendTypeahead", () => {
  test("extends the buffer while the user is still typing", () => {
    expect(appendTypeahead("do", "c", 100)).toBe("doc");
  });

  test("restarts once the user has paused", () => {
    expect(appendTypeahead("do", "c", TYPEAHEAD_RESET_MS + 1)).toBe("c");
  });

  test("the reset boundary itself still counts as continuing", () => {
    expect(appendTypeahead("do", "c", TYPEAHEAD_RESET_MS)).toBe("doc");
  });
});

describe("typeaheadIndex", () => {
  const o = opts("Auto Detect", "Docker", "Podman");

  test("matches on prefix, case-insensitively", () => {
    expect(typeaheadIndex(o, "doc", 0)).toBe(1);
    expect(typeaheadIndex(o, "POD", 0)).toBe(2);
  });

  test("wraps around the end of the list", () => {
    expect(typeaheadIndex(o, "auto", 2)).toBe(0);
  });

  test("returns -1 when nothing matches, so the caller leaves the active index alone", () => {
    expect(typeaheadIndex(o, "zzz", 0)).toBe(-1);
    expect(typeaheadIndex(o, "", 0)).toBe(-1);
  });

  test("a repeated character cycles through options sharing that initial", () => {
    const dupes = opts("Debian", "Docker", "Dhall");
    expect(typeaheadIndex(dupes, "d", 0)).toBe(0);
    expect(typeaheadIndex(dupes, "dd", 0)).toBe(1);
    expect(typeaheadIndex(dupes, "ddd", 1)).toBe(2);
    // …and back round to the start.
    expect(typeaheadIndex(dupes, "dddd", 2)).toBe(0);
  });

  test("never lands on a disabled option", () => {
    const withDisabled: NavOption[] = [
      { label: "Docker", disabled: true },
      { label: "Docker Desktop" },
    ];
    expect(typeaheadIndex(withDisabled, "doc", 0)).toBe(1);
  });
});

describe("native selects", () => {
  /**
   * The bug this component exists to fix was that every dropdown was a native
   * `<select>`, whose popup list the platform draws rather than the page — so it stayed
   * white in dark mode, and on Linux/WebKitGTK it is a GTK menu that no CSS can reach.
   * Nothing catches a reintroduction at type-check time, so scan the source instead.
   * `styles.test.ts` already sets the precedent for source-scanning guards.
   */
  function tsxFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return tsxFiles(full);
      return name.endsWith(".tsx") ? [full] : [];
    });
  }

  /** Drop comments, so prose *about* `<select>` — including this file's — does not trip. */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  test("no component renders a native <select>", () => {
    const src = join(import.meta.dir, "..", "..");
    const offenders = tsxFiles(src).filter((f) =>
      /<select[\s>]/.test(stripComments(readFileSync(f, "utf8"))),
    );
    expect(offenders.map((f) => f.slice(src.length + 1))).toEqual([]);
  });
});
