/**
 * Shared helpers for the three places julIDE's version is declared.
 *
 * These files must always agree — the Tauri bundler reads tauri.conf.json, cargo
 * reads Cargo.toml, and the npm tooling reads package.json. Historically they
 * drifted from the git tags (tags reached v0.1.0-beta4 while every manifest
 * still said 0.1.0), so both the bump script and the CI check live here.
 */

export const PACKAGE_JSON = "package.json";
export const CARGO_TOML = "src-tauri/Cargo.toml";
export const TAURI_CONF = "src-tauri/tauri.conf.json";

export interface VersionSource {
  file: string;
  version: string;
}

/** Strip a leading `v` so `v0.2.0` and `0.2.0` compare equal. */
export function normalizeTag(tag: string): string {
  return tag.replace(/^v/, "");
}

/**
 * Tauri requires a plain `major.minor.patch` — it rejects semver pre-release
 * suffixes in tauri.conf.json. Keep prerelease markers in the git tag only.
 */
export function isValidVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version);
}

async function readPackageJsonVersion(): Promise<string> {
  const pkg = await Bun.file(PACKAGE_JSON).json();
  return pkg.version;
}

async function readTauriConfVersion(): Promise<string> {
  const conf = await Bun.file(TAURI_CONF).json();
  return conf.version;
}

/**
 * Read `version` from the `[package]` table only — dependency versions further
 * down the file must not match.
 */
async function readCargoTomlVersion(): Promise<string> {
  const text = await Bun.file(CARGO_TOML).text();
  const pkgSection = text.split(/^\[/m).find((s) => s.startsWith("package]"));
  const match = pkgSection?.match(/^version\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error(`Could not find [package] version in ${CARGO_TOML}`);
  return match[1];
}

export async function readVersions(): Promise<VersionSource[]> {
  return [
    { file: PACKAGE_JSON, version: await readPackageJsonVersion() },
    { file: CARGO_TOML, version: await readCargoTomlVersion() },
    { file: TAURI_CONF, version: await readTauriConfVersion() },
  ];
}

export async function writeVersions(version: string): Promise<void> {
  // package.json — rewrite the version line to preserve formatting.
  const pkgText = await Bun.file(PACKAGE_JSON).text();
  await Bun.write(
    PACKAGE_JSON,
    pkgText.replace(/^(\s*"version"\s*:\s*)"[^"]+"/m, `$1"${version}"`),
  );

  // tauri.conf.json — same approach.
  const confText = await Bun.file(TAURI_CONF).text();
  await Bun.write(TAURI_CONF, confText.replace(/^(\s*"version"\s*:\s*)"[^"]+"/m, `$1"${version}"`));

  // Cargo.toml — only the first `version` after `[package]`.
  const cargoText = await Bun.file(CARGO_TOML).text();
  let replaced = false;
  await Bun.write(
    CARGO_TOML,
    cargoText.replace(/^version\s*=\s*"[^"]+"/m, (m) => {
      if (replaced) return m;
      replaced = true;
      return `version = "${version}"`;
    }),
  );
}
