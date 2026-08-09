/**
 * Talking to the plugin registry.
 *
 * Thin wrappers over the Rust commands, plus the pure helpers the UI needs. Nothing here
 * fetches: every request happens in Rust so the webview's `connect-src` never has to
 * widen — which would widen it for every plugin sharing that realm.
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  AvailableUpdate,
  InstallResult,
  RegistryEntry,
  RegistryIndex,
} from "../types/marketplace";

export function fetchIndex(forceRefresh = false): Promise<RegistryIndex> {
  return invoke<RegistryIndex>("marketplace_fetch_index", { forceRefresh });
}

export function install(name: string, version: string): Promise<InstallResult> {
  return invoke<InstallResult>("marketplace_install", { name, version });
}

export function uninstall(name: string): Promise<void> {
  return invoke("marketplace_uninstall", { name });
}

export function checkUpdates(): Promise<AvailableUpdate[]> {
  return invoke<AvailableUpdate[]>("marketplace_check_updates");
}

/**
 * Rank entries against a query.
 *
 * Ranked rather than filtered: someone typing a plugin's exact name wants it first, not
 * fourteenth behind everything whose description mentions it.
 */
export function searchIndex(entries: readonly RegistryEntry[], query: string): RegistryEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...entries];

  const scored: { entry: RegistryEntry; score: number }[] = [];
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    const display = entry.displayName.toLowerCase();
    let score = 0;

    if (name === q) score = 100;
    else if (name.startsWith(q)) score = 80;
    else if (name.includes(q)) score = 60;
    else if (display.includes(q)) score = 50;
    else if (entry.keywords.some((k) => k.toLowerCase().includes(q))) score = 30;
    else if ((entry.description ?? "").toLowerCase().includes(q)) score = 20;
    else if (entry.categories.some((c) => c.toLowerCase().includes(q))) score = 10;

    if (score > 0) scored.push({ entry, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .map((s) => s.entry);
}

/** Permissions the new version wants that the installed one did not. */
export function permissionsAdded(before: readonly string[], after: readonly string[]): string[] {
  const had = new Set(before);
  return after.filter((p) => !had.has(p));
}

/** Human size, for the install confirmation. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
