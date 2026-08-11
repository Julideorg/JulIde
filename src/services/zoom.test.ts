import { describe, expect, test } from "bun:test";
import { matchZoomKey, zoomLabel, ZOOM_STEPS } from "./zoom";

/** A KeyboardEvent stand-in — bun test has no DOM to construct a real one. */
function key(code: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return { code, ctrlKey: false, metaKey: false, altKey: false, ...mods } as KeyboardEvent;
}

describe("matchZoomKey", () => {
  test("matches the main row with either accelerator key", () => {
    expect(matchZoomKey(key("Equal", { ctrlKey: true }))).toBe("in");
    expect(matchZoomKey(key("Minus", { ctrlKey: true }))).toBe("out");
    expect(matchZoomKey(key("Digit0", { ctrlKey: true }))).toBe("reset");
    expect(matchZoomKey(key("Equal", { metaKey: true }))).toBe("in");
  });

  test("matches the numpad too", () => {
    expect(matchZoomKey(key("NumpadAdd", { ctrlKey: true }))).toBe("in");
    expect(matchZoomKey(key("NumpadSubtract", { ctrlKey: true }))).toBe("out");
    expect(matchZoomKey(key("Numpad0", { ctrlKey: true }))).toBe("reset");
  });

  test("is matched on code, so a shifted Ctrl+= still zooms in", () => {
    // The `key` for this is "+" rather than "=", and different again on a non-US
    // layout. `code` is the physical key in every case.
    expect(matchZoomKey(key("Equal", { ctrlKey: true, shiftKey: true }))).toBe("in");
  });

  test("ignores the key without an accelerator, and with Alt held", () => {
    expect(matchZoomKey(key("Equal"))).toBeNull();
    expect(matchZoomKey(key("Equal", { ctrlKey: true, altKey: true }))).toBeNull();
  });

  test("ignores unrelated keys", () => {
    expect(matchZoomKey(key("KeyG", { ctrlKey: true }))).toBeNull();
    expect(matchZoomKey(key("Digit1", { ctrlKey: true }))).toBeNull();
  });
});

describe("the zoom ladder", () => {
  test("is ascending, and contains 100%", () => {
    expect(ZOOM_STEPS).toContain(1);
    for (let i = 1; i < ZOOM_STEPS.length; i++) {
      expect(ZOOM_STEPS[i]).toBeGreaterThan(ZOOM_STEPS[i - 1]);
    }
  });

  test("stays inside the range Settings::clamped enforces in Rust", () => {
    expect(ZOOM_STEPS[0]).toBeGreaterThanOrEqual(0.5);
    expect(ZOOM_STEPS[ZOOM_STEPS.length - 1]).toBeLessThanOrEqual(3);
  });

  test("every step has a clean percentage label", () => {
    for (const step of ZOOM_STEPS) expect(zoomLabel(step)).toMatch(/^\d+%$/);
    expect(zoomLabel(1)).toBe("100%");
    expect(zoomLabel(1.25)).toBe("125%");
  });
});
