#!/usr/bin/env bun
/**
 * Fails if src-tauri/assets/plugin-bootstrap.js is out of date with the SDK source.
 *
 * Rust inlines that file into every sandboxed plugin frame. A stale copy means plugins
 * run against an old SDK — silently, because nothing else reads the file.
 *
 * Usage:  bun run check:plugin-bootstrap
 */
import { render } from "./build-plugin-bootstrap";

const OUT = "src-tauri/assets/plugin-bootstrap.js";

const expected = await render();
const actual = await Bun.file(OUT)
  .text()
  .catch(() => null);

if (actual === null) {
  console.error(`${OUT} is missing. Run: bun run build:plugin-bootstrap`);
  process.exit(1);
}
if (actual !== expected) {
  console.error(`${OUT} is stale. Run: bun run build:plugin-bootstrap`);
  process.exit(1);
}
console.log(`${OUT} is up to date.`);
