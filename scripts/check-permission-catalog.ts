#!/usr/bin/env bun
/**
 * Fails if permission-catalog.json is out of date.
 *
 * The plugin registry consumes this file to show users what a plugin can do. A stale one
 * means the registry describes a permission model julIDE no longer has — and it would be
 * believed, because it is published by julIDE.
 *
 * Usage:  bun run check:permission-catalog
 */
import { OUT, render } from "./generate-permission-catalog";

const expected = await render();
const actual = await Bun.file(OUT)
  .text()
  .catch(() => null);

if (actual === null) {
  console.error(`${OUT} is missing. Run: bun run generate:permission-catalog`);
  process.exit(1);
}
if (actual !== expected) {
  console.error(`${OUT} is stale. Run: bun run generate:permission-catalog`);
  process.exit(1);
}
console.log(`${OUT} is up to date.`);
