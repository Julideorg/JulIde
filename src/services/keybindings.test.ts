import { describe, expect, test } from "bun:test";
import {
  matchesKeybinding,
  getKeybindingLabel,
  DEFAULT_KEYBINDINGS,
  type Keybinding,
} from "./keybindings";

// Helper to create a synthetic KeyboardEvent-like object
function fakeEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: "",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  } as KeyboardEvent;
}

describe("matchesKeybinding", () => {
  const binding: Keybinding = { key: "p", ctrlOrCmd: true, label: "⌘P" };

  test("matches with ctrlKey", () => {
    expect(matchesKeybinding(fakeEvent({ key: "p", ctrlKey: true }), binding)).toBe(true);
  });

  test("matches with metaKey", () => {
    expect(matchesKeybinding(fakeEvent({ key: "p", metaKey: true }), binding)).toBe(true);
  });

  test("fails when neither ctrl nor meta pressed", () => {
    expect(matchesKeybinding(fakeEvent({ key: "p" }), binding)).toBe(false);
  });

  test("fails when key does not match", () => {
    expect(matchesKeybinding(fakeEvent({ key: "x", ctrlKey: true }), binding)).toBe(false);
  });

  test("matches shift binding when shiftKey pressed", () => {
    const shiftBinding: Keybinding = { key: "P", ctrlOrCmd: true, shift: true, label: "⌘⇧P" };
    expect(
      matchesKeybinding(fakeEvent({ key: "P", ctrlKey: true, shiftKey: true }), shiftBinding),
    ).toBe(true);
  });

  test("fails shift binding when shiftKey not pressed", () => {
    const shiftBinding: Keybinding = { key: "P", ctrlOrCmd: true, shift: true, label: "⌘⇧P" };
    expect(matchesKeybinding(fakeEvent({ key: "P", ctrlKey: true }), shiftBinding)).toBe(false);
  });

  test("matches alt binding when altKey pressed", () => {
    const altBinding: Keybinding = { key: "a", ctrlOrCmd: true, alt: true, label: "⌘⌥A" };
    expect(
      matchesKeybinding(fakeEvent({ key: "a", ctrlKey: true, altKey: true }), altBinding),
    ).toBe(true);
  });

  test("fails alt binding when altKey not pressed", () => {
    const altBinding: Keybinding = { key: "a", ctrlOrCmd: true, alt: true, label: "⌘⌥A" };
    expect(matchesKeybinding(fakeEvent({ key: "a", ctrlKey: true }), altBinding)).toBe(false);
  });

  test("binding without ctrlOrCmd matches regardless of modifier keys", () => {
    const simpleBinding: Keybinding = { key: "Escape", ctrlOrCmd: false, label: "Esc" };
    expect(matchesKeybinding(fakeEvent({ key: "Escape" }), simpleBinding)).toBe(true);
  });

  test("extra modifiers do not prevent match (no negative checks for unspecified modifiers)", () => {
    // If binding only requires ctrlOrCmd but user also holds shift, it still matches
    expect(matchesKeybinding(fakeEvent({ key: "p", ctrlKey: true, shiftKey: true }), binding)).toBe(
      true,
    );
  });
});

describe("getKeybindingLabel", () => {
  test("returns label for known action", () => {
    expect(getKeybindingLabel("command-palette")).toBe("⌘⇧P");
  });

  test("returns label for quick-open", () => {
    expect(getKeybindingLabel("quick-open")).toBe("⌘P");
  });

  test("returns empty string for unknown action", () => {
    expect(getKeybindingLabel("nonexistent-action")).toBe("");
  });
});

describe("DEFAULT_KEYBINDINGS", () => {
  test("contains all expected keybinding IDs", () => {
    const expectedIds = [
      "command-palette",
      "quick-open",
      "find",
      "find-replace",
      "global-search",
      "toggle-terminal",
      "open-settings",
      "run-file",
    ];
    for (const id of expectedIds) {
      expect(DEFAULT_KEYBINDINGS).toHaveProperty(id);
    }
  });

  test("each binding has required shape", () => {
    for (const [, binding] of Object.entries(DEFAULT_KEYBINDINGS)) {
      expect(binding).toHaveProperty("key");
      expect(binding).toHaveProperty("ctrlOrCmd");
      expect(binding).toHaveProperty("label");
      expect(typeof binding.key).toBe("string");
      expect(typeof binding.ctrlOrCmd).toBe("boolean");
      expect(typeof binding.label).toBe("string");
    }
  });
});
