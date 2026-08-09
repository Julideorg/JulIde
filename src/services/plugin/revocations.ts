/**
 * The registry's advisory feed, applied before a plugin loads.
 *
 * The only control that helps *after* a plugin is already installed. Everything else in
 * the plugin system is a gate on getting in.
 *
 * Two honest limitations, stated here rather than discovered later:
 *
 * - It keys on `name` + `version` **read from the plugin's own manifest**. A deliberately
 *   malicious sideloaded plugin renames itself and walks past this. Revocation mitigates
 *   supply-chain compromise of a registry plugin the user chose to trust; it is not a
 *   defence against hostile local files, and it is not a sandbox.
 * - It fails **open** on a fetch error. An IDE that refuses to load plugins on a plane is
 *   worse than the exposure window. It fails **closed** on a signature failure, where the
 *   Rust side rejects the document and keeps the last verified copy.
 */

import { invoke } from "@tauri-apps/api/core";

export interface Revocation {
  plugin: string;
  /** A version range in the registry's grammar — see `satisfiesRange`. */
  versions: string;
  action: "warn" | "disable";
  severity: "low" | "moderate" | "high" | "critical";
  reason: string;
  advisory?: string | null;
}

export interface RevocationFeed {
  schemaVersion: number;
  serial: number;
  generatedAt: string;
  entries: Revocation[];
}

/** Refreshed on startup and every six hours. */
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compare(a: string, b: string): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    if (x[i]! !== y[i]!) return x[i]! - y[i]!;
  }
  return 0;
}

/**
 * Does `version` fall in `range`?
 *
 * The same grammar the registry uses for `engines.julide`, deliberately: one grammar to
 * implement rather than two that can disagree about which versions an advisory covers.
 * Anything unrecognised returns false — an advisory nobody can parse must not silently
 * match everything.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const trimmed = range.trim();
  if (trimmed === "") return false;
  if (trimmed === "*") return true;

  // `A || B`
  if (trimmed.includes("||")) {
    return trimmed.split("||").some((part) => satisfiesRange(version, part));
  }

  const v = parseVersion(version);
  if (!v) return false;

  const m = /^(>=|<=|>|<|\^|~)?\s*(\d+\.\d+\.\d+)$/.exec(trimmed);
  if (!m) return false;
  const [, op, target] = m;
  const cmp = compare(version, target!);
  if (cmp === null) return false;

  const t = parseVersion(target!)!;
  switch (op) {
    case undefined:
    case "":
      return cmp === 0;
    case ">=":
      return cmp >= 0;
    case "<=":
      return cmp <= 0;
    case ">":
      return cmp > 0;
    case "<":
      return cmp < 0;
    case "^":
      // Caret on 0.x pins the minor, matching the registry's implementation.
      return t[0] === 0 ? v[0] === 0 && v[1] === t[1] && cmp >= 0 : v[0] === t[0] && cmp >= 0;
    case "~":
      return v[0] === t[0] && v[1] === t[1] && cmp >= 0;
    default:
      return false;
  }
}

/** The strongest advisory that applies, or null. */
export function effectiveRevocation(
  feed: RevocationFeed | null,
  plugin: string,
  version: string,
): Revocation | null {
  if (!feed) return null;
  const hits = feed.entries.filter(
    (e) => e.plugin === plugin && satisfiesRange(version, e.versions),
  );
  // `disable` wins: if one entry says a version must not load, another saying it merely
  // deserves a banner does not soften that.
  return hits.find((h) => h.action === "disable") ?? hits[0] ?? null;
}

class RevocationService {
  private feed: RevocationFeed | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastError = "";

  /**
   * Fetch the feed, bounded so a hung network cannot delay startup.
   *
   * Never throws. The whole point is that this cannot be what stops the IDE working.
   */
  async refresh(opts: { force?: boolean; budgetMs?: number } = {}): Promise<void> {
    const fetching = invoke<RevocationFeed | null>("marketplace_fetch_revocations", {
      forceRefresh: opts.force ?? false,
    });

    try {
      const result = opts.budgetMs
        ? await Promise.race([
            fetching,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), opts.budgetMs)),
          ])
        : await fetching;
      // A timeout leaves whatever was already verified in place rather than clearing it.
      if (result) this.feed = result;
      this.lastError = "";
    } catch (e) {
      // Reaching here means the signature failed or the serial went backwards — the
      // Rust side already refused the document. Keep the last verified feed and say so.
      this.lastError = e instanceof Error ? e.message : String(e);
    }
  }

  isRevoked(plugin: string, version: string): Revocation | null {
    return effectiveRevocation(this.feed, plugin, version);
  }

  /** Verification failure, if the last refresh had one. Worth surfacing, not hiding. */
  error(): string {
    return this.lastError;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh({ force: true }), REFRESH_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Testing seam. */
  setFeed(feed: RevocationFeed | null): void {
    this.feed = feed;
  }
}

export const pluginRevocations = new RevocationService();
