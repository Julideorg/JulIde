#!/usr/bin/env bun
/**
 * Set the version in all three manifests at once.
 *
 *   bun run bump-version 0.2.0
 *
 * Pre-release markers belong in the git tag (v0.2.0-rc1), not in the manifests —
 * Tauri rejects them in tauri.conf.json.
 */
import { readVersions, writeVersions, normalizeTag, isValidVersion } from "./versions";
import { OUT as CATALOG_OUT, render as renderCatalog } from "./generate-permission-catalog";

const input = process.argv[2];
if (!input) {
  console.error("Usage: bun run bump-version <version>   (e.g. 0.2.0)");
  process.exit(1);
}

const version = normalizeTag(input);
if (!isValidVersion(version)) {
  console.error(
    `"${input}" is not a plain major.minor.patch version.\n` +
      "Tauri rejects pre-release suffixes in tauri.conf.json — tag as v0.2.0-rc1 but bump to 0.2.0.",
  );
  process.exit(1);
}

const before = await readVersions();
await writeVersions(version);
const after = await readVersions();

for (const [i, s] of after.entries()) {
  const old = before[i].version;
  const marker = s.version === version ? "ok" : "FAILED";
  console.log(`${marker.padEnd(7)} ${s.file.padEnd(28)} ${old} -> ${s.version}`);
}

if (after.some((s) => s.version !== version)) {
  console.error("\nOne or more manifests were not updated. Check them by hand.");
  process.exit(1);
}

// permission-catalog.json embeds julideVersion, so a bump makes it stale and reddens
// CI on the release PR itself. Regenerating here keeps that from being a step someone
// has to remember on the one day they are busiest.
await Bun.write(CATALOG_OUT, await renderCatalog());
console.log(`ok      ${CATALOG_OUT.padEnd(28)} regenerated`);

console.log(`\nAll manifests set to ${version}.`);
console.log("Next: update CHANGELOG.md, commit, then tag (e.g. git tag v" + version + ").");
