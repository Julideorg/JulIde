import { describe, expect, test } from "bun:test";
import { palettes, hexToChannels, type Palette } from "./tokens";

/**
 * Contrast guard for the design tokens.
 *
 * The redesign promises a legible floor in both themes, and the palette it
 * replaced did not have one — the old status bar painted #389826 and #9558b2
 * indicators onto a solid #9558b2 band, which put the Pluto indicator at 1:1.
 * These thresholds make that class of regression a failing test rather than
 * something a reviewer has to notice.
 *
 * Thresholds follow WCAG 2.1: 4.5 for text, 3.0 for muted text and non-text
 * UI that only has to be perceivable.
 */

/** WCAG relative luminance of a `#rrggbb` color. */
function luminance(hex: string): number {
  const [r, g, b] = hexToChannels(hex)
    .split(" ")
    .map((c) => {
      const s = Number(c) / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1–21. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Every background a piece of chrome text can land on. */
function backgrounds(p: Palette) {
  return {
    canvas: p.surface.canvas,
    chrome: p.surface.chrome,
    panel: p.surface.panel,
    raised: p.surface.raised,
    hover: p.surface.hover,
    active: p.surface.active,
  };
}

describe.each(Object.entries(palettes))("%s palette", (_name, p) => {
  test("primary text is comfortably legible on every surface", () => {
    for (const [bgName, bg] of Object.entries(backgrounds(p))) {
      expect(`${bgName}: ${contrast(p.fg.hi, bg).toFixed(2)}`).toBe(
        `${bgName}: ${Math.max(contrast(p.fg.hi, bg), 7).toFixed(2)}`,
      );
    }
  });

  test("secondary text meets AA on every surface", () => {
    for (const [bgName, bg] of Object.entries(backgrounds(p))) {
      const ratio = contrast(p.fg.mid, bg);
      expect({ bgName, ok: ratio >= 4.5, ratio: +ratio.toFixed(2) }).toMatchObject({
        bgName,
        ok: true,
      });
    }
  });

  test("muted text stays perceivable on every surface", () => {
    for (const [bgName, bg] of Object.entries(backgrounds(p))) {
      const ratio = contrast(p.fg.lo, bg);
      expect({ bgName, ok: ratio >= 3, ratio: +ratio.toFixed(2) }).toMatchObject({
        bgName,
        ok: true,
      });
    }
  });

  test("mode colors meet AA on the surfaces they label", () => {
    const surfaces = { canvas: p.surface.canvas, chrome: p.surface.chrome, panel: p.surface.panel };
    for (const [modeName, mode] of Object.entries(p.mode)) {
      for (const [bgName, bg] of Object.entries(surfaces)) {
        const ratio = contrast(mode, bg);
        expect({ modeName, bgName, ok: ratio >= 4.5, ratio: +ratio.toFixed(2) }).toMatchObject({
          modeName,
          bgName,
          ok: true,
        });
      }
    }
  });

  test("inverse text is legible on every filled mode color", () => {
    for (const [modeName, mode] of Object.entries(p.mode)) {
      const ratio = contrast(p.fg.inverse, mode);
      expect({ modeName, ok: ratio >= 4.5, ratio: +ratio.toFixed(2) }).toMatchObject({
        modeName,
        ok: true,
      });
    }
  });

  test("syntax colors meet AA against the editor canvas", () => {
    for (const [tokenName, color] of Object.entries(p.syntax)) {
      const ratio = contrast(color, p.surface.canvas);
      expect({ tokenName, ok: ratio >= 4.5, ratio: +ratio.toFixed(2) }).toMatchObject({
        tokenName,
        ok: true,
      });
    }
  });
});
