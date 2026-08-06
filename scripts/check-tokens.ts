#!/usr/bin/env bun
/**
 * Fails if src/styles/tokens.css is out of date with src/themes/tokens.ts.
 *
 * Catches the case where someone edits a token and forgets to regenerate, which
 * would silently leave the stylesheet on the old values.
 *
 * Usage:  bun run check:tokens
 */

import { render } from "./generate-tokens";

const OUT = "src/styles/tokens.css";

const expected = render();
const actual = await Bun.file(OUT)
  .text()
  .catch(() => null);

if (actual === null) {
  console.error(`${OUT} is missing. Run: bun run generate:tokens`);
  process.exit(1);
}

if (actual !== expected) {
  console.error(`${OUT} is stale. Run: bun run generate:tokens`);
  process.exit(1);
}

console.log(`${OUT} is up to date.`);
