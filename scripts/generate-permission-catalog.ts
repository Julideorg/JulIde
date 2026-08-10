#!/usr/bin/env bun
/**
 * Generates permission-catalog.json from the permission model and the Tauri command list.
 *
 * This is an *outbound contract artifact*, not app source. julIDE reads its catalog from
 * TypeScript directly; this file exists so the plugin registry can show a user exactly
 * the wording julIDE's consent dialog shows. If the registry paraphrased it, someone
 * would read one description on a pull request and a different one when approving the
 * plugin, learn the dialog is boilerplate, and stop reading it.
 *
 * `allCommands` minus the keys of `commandPermissions` is independently useful: it is the
 * set of commands that exist but plugins may never call, so a plugin naming one is
 * probing rather than mistaken.
 *
 * Usage:  bun run generate:permission-catalog
 */
import {
  ALL_PERMISSIONS,
  COMMAND_PERMISSIONS,
  EVENT_PERMISSIONS,
  PERMISSION_CATALOG,
} from "../src/services/pluginPermissions";
import pkg from "../package.json";

export const OUT = "permission-catalog.json";
const HANDLER_SOURCE = "src-tauri/src/lib.rs";

/**
 * Bumped when the *shape* below changes, not when its contents do.
 *
 * A consumer pins this to know whether it can still parse the file.
 */
const CATALOG_VERSION = 1;

/**
 * A floor on the scraped command count.
 *
 * Exists so a broken scrape is loud. A regex that silently matched less would produce a
 * shorter-but-non-empty list, which is worse than an empty one: every assertion below
 * would still pass and the registry would quietly believe a truncated catalog. Bump it
 * deliberately if commands are ever removed en masse.
 */
const MIN_EXPECTED_COMMANDS = 100;

/**
 * The text between `generate_handler![` and its matching `]`.
 *
 * A scanner rather than a regex. The block already contains `//` comment banners, and a
 * future `/* … ] … *\/` or a string literal containing a bracket would silently truncate
 * a regex-based extraction — producing a shorter list that still looks plausible.
 */
export function extractHandlerSlice(source: string): string {
  const marker = /(?:tauri\s*::\s*)?generate_handler\s*!\s*\[/g;
  const matches = [...source.matchAll(marker)];
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one generate_handler! in ${HANDLER_SOURCE}, found ${matches.length}. ` +
        `Either the macro moved or there is now more than one command list — this script assumes one.`,
    );
  }

  const start = matches[0]!.index! + matches[0]![0].length;
  // No char-literal state: `'` in Rust also opens a lifetime (`'a`), and treating the
  // two alike would swallow the rest of the block. A command list contains neither, so
  // the omission is a deliberate narrowing of what this parses rather than a gap.
  type State = "code" | "line" | "block" | "string";
  let state: State = "code";
  let depth = 1;

  for (let i = start; i < source.length; i++) {
    const c = source[i]!;
    const next = source[i + 1];

    switch (state) {
      case "line":
        if (c === "\n") state = "code";
        break;
      case "block":
        if (c === "*" && next === "/") {
          state = "code";
          i++;
        }
        break;
      case "string":
        if (c === "\\") i++;
        else if (c === '"') state = "code";
        break;
      case "code":
        if (c === "/" && next === "/") {
          state = "line";
          i++;
        } else if (c === "/" && next === "*") {
          state = "block";
          i++;
        } else if (c === '"') state = "string";
        else if (c === "[") depth++;
        else if (c === "]") {
          depth--;
          if (depth === 0) return source.slice(start, i);
        }
        break;
    }
  }

  throw new Error(`Unterminated generate_handler! in ${HANDLER_SOURCE}.`);
}

/** Command names out of a handler slice. Anything unparseable throws rather than drops. */
export function parseCommandList(slice: string): string[] {
  const withoutComments = slice.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  const names: string[] = [];
  for (const raw of withoutComments.split(",")) {
    const item = raw.trim();
    if (item === "") continue;
    // `module::command` or `crate::a::b` — the last segment is the command name.
    const m = /^(?:[A-Za-z_]\w*::)+([A-Za-z_]\w*)$/.exec(item);
    if (!m) {
      throw new Error(
        `Could not parse "${item}" as a command path in ${HANDLER_SOURCE}. ` +
          `Dropping it silently would understate what plugins may never call.`,
      );
    }
    names.push(m[1]!);
  }
  return names.sort();
}

/** Scrape and assert. The assertions are the point. */
export function scrapeCommands(source: string): string[] {
  const commands = parseCommandList(extractHandlerSlice(source));

  if (commands.length < MIN_EXPECTED_COMMANDS) {
    throw new Error(
      `Only ${commands.length} commands scraped, expected at least ${MIN_EXPECTED_COMMANDS}. ` +
        `A truncated list is worse than none — it would be believed.`,
    );
  }

  const duplicates = commands.filter((c, i) => commands.indexOf(c) !== i);
  if (duplicates.length > 0) {
    throw new Error(
      `Duplicate commands in the handler list: ${[...new Set(duplicates)].join(", ")}`,
    );
  }

  // A renamed Rust command leaving a dangling TS mapping is otherwise invisible: the
  // stale entry just never matches anything.
  const known = new Set(commands);
  const dangling = Object.keys(COMMAND_PERMISSIONS).filter((c) => !known.has(c));
  if (dangling.length > 0) {
    throw new Error(
      `COMMAND_PERMISSIONS maps commands that no longer exist: ${dangling.join(", ")}. ` +
        `Either the Rust command was renamed or the mapping is stale.`,
    );
  }

  // The "plugins cannot manage plugins" invariant, hardcoded here so it survives a
  // careless paste into the map.
  const selfManaging = Object.keys(COMMAND_PERMISSIONS).filter(
    (c) => c.startsWith("plugin_") || c.startsWith("marketplace_"),
  );
  if (selfManaging.length > 0) {
    throw new Error(
      `COMMAND_PERMISSIONS must never map a plugin-management command: ${selfManaging.join(", ")}. ` +
        `A plugin that can install plugins is privilege escalation with no legitimate use.`,
    );
  }

  // Same shape of invariant for the image commands. `image_load` is "read this
  // workspace file, or GET this https URL, and hand me the bytes" — mapped to a
  // permission it would be a file-read and network-egress channel for a plugin whose
  // frame CSP says `connect-src 'none'`, routing around the declared-network model.
  // It is also gated on a setting the user answered about julIDE, not about a plugin.
  const imageCommands = Object.keys(COMMAND_PERMISSIONS).filter((c) => c.startsWith("image_"));
  if (imageCommands.length > 0) {
    throw new Error(
      `COMMAND_PERMISSIONS must never map an image command: ${imageCommands.join(", ")}. ` +
        `It would give a plugin workspace file reads and arbitrary https egress.`,
    );
  }

  return commands;
}

export async function render(): Promise<string> {
  const source = await Bun.file(HANDLER_SOURCE).text();

  const catalog = {
    catalogVersion: CATALOG_VERSION,
    julideVersion: pkg.version,
    // Declaration order, which is risk-grouped and deliberate.
    permissions: ALL_PERMISSIONS.map((id) => ({
      id,
      title: PERMISSION_CATALOG[id].title,
      description: PERMISSION_CATALOG[id].description,
      risk: PERMISSION_CATALOG[id].risk,
    })),
    // Sorted, so a diff is reviewable rather than a reshuffle.
    commandPermissions: Object.fromEntries(
      Object.entries(COMMAND_PERMISSIONS).sort(([a], [b]) => a.localeCompare(b)),
    ),
    eventPermissions: Object.fromEntries(
      Object.entries(EVENT_PERMISSIONS).sort(([a], [b]) => a.localeCompare(b)),
    ),
    allCommands: scrapeCommands(source),
  };

  return JSON.stringify(catalog, null, 2) + "\n";
}

if (import.meta.main) {
  await Bun.write(OUT, await render());
  console.log(`Wrote ${OUT}`);
}
