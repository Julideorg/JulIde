/**
 * The registry wire types, mirroring `src-tauri/src/marketplace.rs`.
 *
 * Hand-written rather than generated, following the convention every other Tauri DTO in
 * this codebase uses. The Rust side is the authority: it verifies the signature and
 * sanitises the strings before any of this reaches the renderer.
 */

export interface RegistryEngines {
  julide: string;
}

export interface RegistryVersion {
  version: string;
  tarball: string;
  sha256: string;
  sizeBytes: number;
  /** julIDE's own grant fingerprint, so we can say whether an update re-prompts. */
  manifestHash: string;
  apiVersion: number;
  permissions: string[];
  network: string[];
  engines: RegistryEngines;
  publishedAt: string;
  yanked?: boolean;
}

export interface RegistryCapability {
  /** Plain-English summary, computed by the registry from the same permission catalog. */
  headline: string;
  capabilities: string[];
  additionalCount: number;
  tier: string;
}

export interface RegistryEntry {
  name: string;
  displayName: string;
  description?: string;
  author: string;
  repository: string;
  homepage?: string;
  license: string;
  categories: string[];
  keywords: string[];
  /** Null when every version has been yanked. */
  latest: RegistryVersion | null;
  capability: RegistryCapability;
}

export interface RegistryIndex {
  schemaVersion: number;
  generatedAt: string;
  /** Registry-wide stop on installs and updates. Existing plugins keep working. */
  paused: boolean;
  count: number;
  plugins: RegistryEntry[];
}

export interface AvailableUpdate {
  name: string;
  installedVersion: string;
  availableVersion: string;
  /** Permissions the new version asks for that the installed one did not. */
  permissionsAdded: string[];
}

export interface InstallResult {
  name: string;
  version: string;
  manifest: import("./plugin").PluginManifest;
}
