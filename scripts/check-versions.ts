#!/usr/bin/env bun
/**
 * Verify that package.json, src-tauri/Cargo.toml, and src-tauri/tauri.conf.json
 * all declare the same version — and, when run on a tag build, that they match
 * the tag being released.
 *
 * Run by CI (.github/workflows/ci.yml) and usable locally via `bun run check:versions`.
 */
import { readVersions, normalizeTag, isValidVersion } from "./versions";

const sources = await readVersions();
const [first, ...rest] = sources;

let failed = false;

const mismatched = rest.filter((s) => s.version !== first.version);
if (mismatched.length > 0) {
  console.error("Version mismatch across manifests:");
  for (const s of sources) console.error(`  ${s.file.padEnd(28)} ${s.version}`);
  console.error("\nRun `bun run bump-version <version>` to sync them.");
  failed = true;
} else {
  console.log(`All manifests agree: ${first.version}`);
}

if (!isValidVersion(first.version)) {
  console.error(
    `\n${first.version} is not a plain major.minor.patch. ` +
      "Tauri rejects pre-release suffixes in tauri.conf.json — keep those in the git tag only.",
  );
  failed = true;
}

// On a tag build, the tag must match what the manifests say.
const ref = process.env.GITHUB_REF ?? "";
if (ref.startsWith("refs/tags/")) {
  const tag = normalizeTag(ref.slice("refs/tags/".length));
  // Allow the tag to carry a pre-release suffix the manifests cannot: v0.2.0-rc1 matches 0.2.0.
  const tagBase = tag.split("-")[0];
  if (tagBase !== first.version) {
    console.error(`\nTag ${tag} does not match the manifest version ${first.version}.`);
    failed = true;
  } else {
    console.log(`Tag ${tag} matches the manifest version.`);
  }
}

process.exit(failed ? 1 : 0);
