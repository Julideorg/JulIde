import { describe, expect, test, beforeEach } from "bun:test";
import { ASCII_FOLD, foldAscii, toAscii } from "./ascii";
import { useSettingsStore } from "../stores/useSettingsStore";
import { resetAllStores } from "../__test__/storeTestUtils";

const fold = (s: string) => foldAscii(s, true);

beforeEach(() => {
  resetAllStores();
});

describe("toAscii", () => {
  test("follows the setting", () => {
    // The imperative entry point, used by the callers with no component to hold a hook:
    // Monaco decorations, code lenses, the markdown renderer, thrown Errors.
    expect(useSettingsStore.getState().settings.asciiOnly).toBe(false);
    expect(toAscii("Settings → Appearance")).toBe("Settings → Appearance");

    useSettingsStore.setState((s) => ({ settings: { ...s.settings, asciiOnly: true } }));
    expect(toAscii("Settings → Appearance")).toBe("Settings -> Appearance");
    expect(toAscii("Running…")).toBe("Running...");
  });
});

describe("foldAscii", () => {
  test("off is a no-op", () => {
    expect(foldAscii("Settings → Appearance …", false)).toBe("Settings → Appearance …");
  });

  test("folds prose punctuation", () => {
    expect(fold("Uses SSH key auth — never stores passwords")).toBe(
      "Uses SSH key auth - never stores passwords",
    );
    expect(fold("Detecting Julia…")).toBe("Detecting Julia...");
    expect(fold("Images are turned off in Settings → Appearance")).toBe(
      "Images are turned off in Settings -> Appearance",
    );
    expect(fold("ofek · MIT · 12 KB")).toBe("ofek | MIT | 12 KB");
  });

  test("composes keyboard chords without joining logic", () => {
    // Each modifier carries its own trailing `+`, and `↵` is terminal, so the chords
    // fall out of a per-character map.
    expect(fold("⌘⇧P")).toBe("Cmd+Shift+P");
    expect(fold("⌘P")).toBe("Cmd+P");
    expect(fold("⌘,")).toBe("Cmd+,");
    expect(fold("⌃`")).toBe("Ctrl+`");
    expect(fold("⌃F5")).toBe("Ctrl+F5");
    expect(fold("⌘↵")).toBe("Cmd+Enter");
  });

  test("the two chords a per-character map would get wrong", () => {
    // `⌘` -> `Cmd+` would leave `Cmd++` and `Cmd+-`; the multi-character entries win
    // because the pattern is built longest-key-first.
    expect(fold("⌘+")).toBe("Cmd+Plus");
    expect(fold("⌘-")).toBe("Cmd+Minus");
    // The neighbouring zoom shortcut must not be caught by them.
    expect(fold("⌘0")).toBe("Cmd+0");
  });

  test("a bare return glyph reads as a word", () => {
    expect(fold("↵ install")).toBe("Enter install");
  });

  test("handles a character outside the BMP", () => {
    // U+1F5BC. A non-unicode regex would split this into lone surrogates.
    expect(fold("🖼")).toBe("[img]");
    expect(fold("🖼 diagram.png")).toBe("[img] diagram.png");
  });

  test("leaves everything not in the table alone", () => {
    // The fold is a whitelist, which is what keeps it safe near data.
    expect(fold("José.jl")).toBe("José.jl");
    expect(fold("∇f(x̄)")).toBe("∇f(x̄)");
    expect(fold("α = β")).toBe("α = β");
    expect(fold("feature/naïve-parser")).toBe("feature/naïve-parser");
  });

  test("is a no-op on text that is already ASCII", () => {
    expect(fold("Open Folder")).toBe("Open Folder");
    expect(fold("")).toBe("");
  });

  test("is idempotent", () => {
    for (const s of ["a — b … c", "⌘⇧P", "⌘+", "☑ done", "🖼", "add Plots · rm Plots"]) {
      expect(fold(fold(s))).toBe(fold(s));
    }
  });

  test("every replacement is itself ASCII", () => {
    // Otherwise the fold would emit exactly what it exists to remove.
    for (const [from, to] of Object.entries(ASCII_FOLD)) {
      // eslint-disable-next-line no-control-regex -- the point is the ASCII range itself
      expect({ from, to, ascii: /^[\x00-\x7F]*$/.test(to) }).toEqual({ from, to, ascii: true });
    }
  });
});
