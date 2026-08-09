/**
 * Validation of `plugin.json`, ahead of anything being created for the plugin.
 *
 * Two things make this load-bearing rather than tidy-up.
 *
 * First, views are declarative in API v2. The activity-bar entry and the panel tab have
 * to exist before the plugin's code has run — that is what allows a view frame to be
 * created lazily, on first show, instead of every plugin spinning up a frame at
 * startup. So the host reads the view list here and never asks the plugin for it.
 *
 * Second, `apiVersion` is the migration gate. A v1 plugin expects a live `HTMLElement`
 * from `render(el)` and a synchronous `ctx`, neither of which exists across a frame
 * boundary. It is refused with an explanation rather than loaded into a world where it
 * silently half-works.
 *
 * Pure — no DOM, no `invoke`, no stores.
 */

import { parseNetworkOrigins, type NetworkPolicy } from "./network";

/** The API generation this build of julIDE speaks. */
export const SUPPORTED_API_VERSION = 2;

/**
 * Icons a plugin may name.
 *
 * Closed on purpose. An arbitrary string reaching an `<img src>` would be an
 * exfiltration channel (the request itself is the signal), and reaching inline SVG
 * would be script injection. Keep in step with `ICON_MAP` in ActivityBar.tsx.
 */
export const PLUGIN_ICONS = [
  "Files",
  "Search",
  "GitBranch",
  "Container",
  "Puzzle",
  "List",
  "Eye",
] as const;

export type PluginIcon = (typeof PLUGIN_ICONS)[number];

export type PluginViewKind = "sidebar" | "panel";

export interface PluginViewDeclaration {
  /** Unqualified, as written in the manifest. The host prefixes it with the plugin id. */
  id: string;
  kind: PluginViewKind;
  title: string;
  /** Sidebar views need one for the activity bar; panel views ignore it. */
  icon: PluginIcon;
}

export interface ParsedManifest {
  name: string;
  version: string;
  displayName: string;
  description?: string;
  author?: string;
  main: string;
  apiVersion: number;
  activationEvents: string[];
  /** Raw, as declared. Filtering to known permissions happens at consent. */
  permissions: string[];
  network: NetworkPolicy;
  views: PluginViewDeclaration[];
}

export type ManifestResult =
  | { ok: true; manifest: ParsedManifest; warnings: string[] }
  | { ok: false; errors: string[]; incompatible: boolean };

const MAX_VIEWS = 8;
const MAX_TITLE = 60;
/** Matches julIDE's own plugin-name grammar for a single path component. */
const VIEW_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$|^[a-z0-9]$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Validate a raw manifest object.
 *
 * `incompatible: true` distinguishes "built for the old API" from "malformed" — the
 * first deserves a migration link in Settings, the second deserves a parse error.
 */
export function parseManifest(raw: unknown): ManifestResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(raw)) {
    return { ok: false, errors: ["plugin.json is not an object"], incompatible: false };
  }

  const apiVersion = typeof raw.apiVersion === "number" ? raw.apiVersion : 1;
  if (apiVersion !== SUPPORTED_API_VERSION) {
    return {
      ok: false,
      incompatible: true,
      errors: [
        `Built for the julIDE ${apiVersion}.x plugin API; this julIDE speaks ${SUPPORTED_API_VERSION}.x. ` +
          `Plugins now run in a sandboxed frame, so the panel API and the shape of \`ctx\` both changed. ` +
          `See docs/PLUGIN_API_V2.md.`,
      ],
    };
  }

  const name = str(raw.name);
  const version = str(raw.version);
  const main = str(raw.main);
  const displayName = str(raw.displayName) ?? name;

  if (!name) errors.push("`name` is required");
  if (!version) errors.push("`version` is required");
  if (!main) errors.push("`main` is required");

  const network = parseNetworkOrigins(stringArray(raw.network));
  for (const r of network.rejected) {
    warnings.push(`network entry "${r.value}" ignored: ${r.reason}`);
  }

  const { views, viewErrors } = parseViews(raw.contributes);
  errors.push(...viewErrors);

  if (errors.length > 0 || !name || !version || !main || !displayName) {
    return { ok: false, errors, incompatible: false };
  }

  return {
    ok: true,
    warnings,
    manifest: {
      name,
      version,
      displayName,
      description: str(raw.description),
      author: str(raw.author),
      main,
      apiVersion,
      activationEvents: stringArray(raw.activationEvents),
      permissions: stringArray(raw.permissions),
      network,
      views,
    },
  };
}

function parseViews(contributes: unknown): {
  views: PluginViewDeclaration[];
  viewErrors: string[];
} {
  const viewErrors: string[] = [];
  const views: PluginViewDeclaration[] = [];

  if (!isRecord(contributes)) return { views, viewErrors };
  const raw = contributes.views;
  if (raw === undefined) return { views, viewErrors };
  if (!Array.isArray(raw)) {
    viewErrors.push("`contributes.views` must be an array");
    return { views, viewErrors };
  }
  if (raw.length > MAX_VIEWS) {
    viewErrors.push(`at most ${MAX_VIEWS} views may be contributed`);
    return { views, viewErrors };
  }

  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry)) {
      viewErrors.push("each entry in `contributes.views` must be an object");
      continue;
    }
    const id = str(entry.id);
    const title = str(entry.title);
    const kind = entry.kind;
    const icon = entry.icon;

    if (!id || !VIEW_ID_PATTERN.test(id)) {
      // The id becomes part of a DOM id and a frame URL, so it stays to the same
      // grammar plugin names use rather than accepting anything stringy.
      viewErrors.push(`view id "${String(entry.id)}" must be lowercase alphanumeric with hyphens`);
      continue;
    }
    if (seen.has(id)) {
      // Two views with one id would collide in the registry and one would silently
      // win, which is a confusing way to lose a panel.
      viewErrors.push(`duplicate view id "${id}"`);
      continue;
    }
    if (kind !== "sidebar" && kind !== "panel") {
      viewErrors.push(`view "${id}" must declare kind "sidebar" or "panel"`);
      continue;
    }
    if (!title || title.length > MAX_TITLE) {
      viewErrors.push(`view "${id}" needs a title of at most ${MAX_TITLE} characters`);
      continue;
    }
    if (typeof icon !== "string" || !(PLUGIN_ICONS as readonly string[]).includes(icon)) {
      viewErrors.push(
        `view "${id}" must use one of the built-in icons: ${PLUGIN_ICONS.join(", ")}`,
      );
      continue;
    }

    seen.add(id);
    views.push({ id, kind, title, icon: icon as PluginIcon });
  }

  return { views, viewErrors };
}
