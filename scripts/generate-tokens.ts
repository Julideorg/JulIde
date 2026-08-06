#!/usr/bin/env bun
/**
 * Generates src/styles/tokens.css from src/themes/tokens.ts.
 *
 * The CSS custom properties, the Monaco editor themes and the xterm palettes
 * all have to agree. Rather than trust three hand-maintained copies of the same
 * hex values — which is exactly how the pre-redesign chrome and editor drifted
 * apart — the TypeScript module is authoritative and this script derives the
 * stylesheet from it.
 *
 * Usage:  bun run generate:tokens
 *
 * `scripts/check-tokens.ts` re-runs this and fails if the checked-in file is
 * stale, so CI catches an edit to tokens.ts that was never regenerated.
 */

import {
  palettes,
  space,
  radius,
  type,
  fontStack,
  weight,
  motion,
  zIndex,
  layout,
  hexToChannels,
  hoverOf,
  type Palette,
} from "../src/themes/tokens";

const OUT = "src/styles/tokens.css";

function paletteBlock(p: Palette, isDark: boolean): string {
  const L: string[] = [];
  const put = (name: string, value: string) => L.push(`  --${name}: ${value};`);

  L.push("  /* Surfaces */");
  for (const [k, v] of Object.entries(p.surface)) put(`surface-${k}`, v);
  put("surface-canvas-rgb", hexToChannels(p.surface.canvas));

  L.push("", "  /* Hairlines */");
  put("hairline", p.hairline.default);
  put("hairline-strong", p.hairline.strong);

  L.push("", "  /* Foreground */");
  for (const [k, v] of Object.entries(p.fg)) put(`fg-${k}`, v);

  L.push("", "  /* Julia REPL modes — semantic accents */");
  for (const [k, v] of Object.entries(p.mode)) {
    const rgb = hexToChannels(v);
    put(`mode-${k}`, v);
    put(`mode-${k}-rgb`, rgb);
    put(`mode-${k}-hover`, hoverOf(v, isDark));
    put(`mode-${k}-tint-weak`, `rgb(${rgb} / 0.10)`);
    put(`mode-${k}-tint`, `rgb(${rgb} / 0.16)`);
    put(`mode-${k}-tint-strong`, `rgb(${rgb} / 0.24)`);
  }

  L.push("", "  /* Status aliases — same colors, named by meaning */");
  put("status-success", p.mode.run);
  put("status-info", p.mode.pkg);
  put("status-warn", p.mode.help);
  put("status-danger", p.mode.shell);
  put("status-success-tint", `rgb(${hexToChannels(p.mode.run)} / 0.16)`);
  put("status-info-tint", `rgb(${hexToChannels(p.mode.pkg)} / 0.16)`);
  put("status-warn-tint", `rgb(${hexToChannels(p.mode.help)} / 0.16)`);
  put("status-danger-tint", `rgb(${hexToChannels(p.mode.shell)} / 0.16)`);

  L.push("", "  /* Syntax */");
  for (const [k, v] of Object.entries(p.syntax)) put(`syntax-${k}`, v);

  L.push("", "  /* Elevation, scrim, editor */");
  put("elev-1", p.elevation.e1);
  put("elev-2", p.elevation.e2);
  put("elev-3", p.elevation.e3);
  put("scrim", p.scrim);
  put("editor-selection", p.editor.selection);
  put("editor-line-highlight", p.editor.lineHighlight);

  L.push("", "  /* Focus ring */");
  put("border-focus", p.mode.brand);
  put("focus-ring", `0 0 0 2px rgb(${hexToChannels(p.mode.brand)} / 0.55)`);

  L.push("", "  /* Scrollbars */");
  put("scrollbar", p.surface.active);
  put("scrollbar-hover", p.hairline.strong);

  L.push("", "  /* ── Legacy aliases ──────────────────────────────────────");
  L.push("     Kept so the pre-redesign rules in src/styles/*.css keep");
  L.push("     rendering while they are migrated onto the tokens above.");
  L.push("     Remove once no stylesheet references them. */");
  put("bg-primary", p.surface.canvas);
  put("bg-secondary", p.surface.panel);
  put("bg-tertiary", p.surface.raised);
  put("bg-hover", p.surface.hover);
  put("bg-active", p.surface.active);
  put("border", p.hairline.default);
  put("border-light", p.hairline.strong);
  put("text-primary", p.fg.hi);
  put("text-secondary", p.fg.mid);
  put("text-muted", p.fg.lo);
  put("accent", p.mode.brand);
  put("accent-hover", hoverOf(p.mode.brand, isDark));
  put("accent-green", p.mode.run);
  put("accent-red", p.mode.shell);
  put("accent-blue", p.mode.pkg);
  put("tab-active-bg", p.surface.canvas);
  put("tab-inactive-bg", p.surface.panel);

  return L.join("\n");
}

function scaleBlock(): string {
  const L: string[] = [];
  const put = (name: string, value: string) => L.push(`  --${name}: ${value};`);

  L.push("  /* Spacing — 4px base with 2px and 6px half-steps */");
  for (const [k, v] of Object.entries(space)) put(`space-${k}`, v);

  L.push("", "  /* Radius */");
  for (const [k, v] of Object.entries(radius)) put(`radius-${k}`, v);

  L.push("", "  /* Type */");
  put("font-ui", fontStack.ui);
  put("font-condensed", fontStack.condensed);
  put("font-mono", fontStack.mono);
  for (const [k, v] of Object.entries(type)) {
    put(`text-${k}`, v.size);
    put(`leading-${k}`, v.line);
  }
  for (const [k, v] of Object.entries(weight)) put(`weight-${k}`, v);

  L.push("", "  /* Motion */");
  for (const [k, v] of Object.entries(motion.duration)) put(`dur-${k}`, v);
  put("ease-out", motion.ease.out);
  put("ease-in-out", motion.ease.inOut);

  L.push("", "  /* Z-index */");
  for (const [k, v] of Object.entries(zIndex)) put(`z-${k}`, String(v));

  L.push("", "  /* Chrome dimensions */");
  put("toolbar-height", layout.toolbarHeight);
  put("statusbar-height", layout.statusbarHeight);
  put("tabs-height", layout.tabsHeight);
  put("panel-tabs-height", layout.panelTabsHeight);
  put("activitybar-width", layout.activityBarWidth);
  put("activitybar-width-compact", layout.activityBarCompactWidth);

  return L.join("\n");
}

export function render(): string {
  return `/* =========================================================
   julIDE design tokens — GENERATED FILE, DO NOT EDIT.

   Source:    src/themes/tokens.ts
   Regenerate: bun run generate:tokens

   Direction "Instrument": a cool blue-graphite ground with Julia's own
   REPL prompt modes as the semantic accent palette —
   julia> green, pkg> blue, help?> yellow, shell> red, brand purple.
   ========================================================= */

:root {
${scaleBlock()}
}

/* Dark is the default, so its values live on :root as well as .theme-dark —
   html/body paint from :root before .theme-* is applied to .ide-root. */
:root,
.theme-dark {
${paletteBlock(palettes.dark, true)}
}

.theme-light {
${paletteBlock(palettes.light, false)}
}
`;
}

if (import.meta.main) {
  await Bun.write(OUT, render());
  console.log(`Wrote ${OUT}`);
}
