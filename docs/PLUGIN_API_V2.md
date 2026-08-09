# julIDE plugin API v2

Plugins run in a sandboxed frame of their own. This document is what you need to write
one, and what changed if you wrote one against v1.

## What the sandbox means for you

Your plugin runs in an `<iframe sandbox="allow-scripts">` with an opaque origin, served
over an internal `julide-plugin://` scheme with a Content-Security-Policy built from your
manifest. In practice:

- There is no `window.__TAURI_INTERNALS__` and no access to julIDE's DOM. Everything you
  can do arrives through `ctx`.
- `fetch` reaches only the hosts you declared in `network`. With none declared,
  `connect-src` is `'none'` and every request fails.
- `localStorage`, `sessionStorage` and cookies all throw. An opaque origin has no
  storage. Persist through `ctx.workspace` or a Tauri command you have permission for.
- **Everything on `ctx` returns a promise**, including reads that used to be synchronous.
  `ctx` is a proxy over a message port; there is nothing synchronous on the other side.

This is not a hardening pass over the old model — it is the reason the permission list
means anything. Before it, a plugin could reach every Tauri command without declaring a
thing, and the consent dialog described intent rather than capability.

## Your entry file

**One bundled classic script that assigns `window.julide`.**

```js
window.julide.activate = async function activate(ctx) {
  ctx.log.info("hello");
};
```

Two constraints, both measurable rather than stylistic:

- **A single file.** `main` is inlined into the frame document, because a `<script src>`
  load from an opaque origin is a CORS fetch that this scheme does not satisfy. Bundle
  with any tool you like; assets (CSS, images, fonts) still load normally from your
  plugin directory.
- **Not an ES module.** An inline `<script type="module">` does not execute in this frame
  on WebKitGTK — no code runs and no error is raised, so the plugin simply looks inert.
  Target `iife` in your bundler. You can still write ESM and let the bundler flatten it.

If your bundler emits a library under a global name, point it at `julide` and you are
done. Otherwise assign the exports yourself, as above.

## `plugin.json`

```json
{
  "apiVersion": 2,
  "name": "julia-fmt",
  "version": "1.0.0",
  "displayName": "Julia Formatter",
  "description": "Formats Julia source with JuliaFormatter.jl.",
  "author": "Ada Lovelace",
  "main": "dist/index.js",
  "permissions": ["workspace:read", "workspace:write", "julia:run"],
  "network": ["https://api.example.com"],
  "contributes": {
    "views": [{ "id": "log", "kind": "panel", "title": "Formatter Log", "icon": "List" }]
  }
}
```

| Field               | Notes                                                                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiVersion`        | Must be `2`. Absent means 1, and julIDE refuses to load it with a message pointing here.                                                                                           |
| `name`              | The plugin's identity. Must equal the directory name — a mismatch is rejected, because grants are keyed by this string.                                                            |
| `main`              | One bundled classic script, resolved inside your plugin directory.                                                                                                                 |
| `permissions`       | See the catalog below. Unknown entries are ignored and reported.                                                                                                                   |
| `network`           | Exact `https://` origins. No wildcards, no bare schemes, no paths, no credentials. `http://` is accepted only for `localhost`. Rejected entries are ignored and shown to the user. |
| `contributes.views` | Declarative. Up to 8; each needs `id`, `kind` (`sidebar`/`panel`), `title`, and an `icon` from the list below.                                                                     |

Icons are a closed set: `Files`, `Search`, `GitBranch`, `Container`, `Puzzle`, `List`,
`Eye`. An arbitrary icon string reaching an `<img src>` would be an exfiltration channel —
the request itself is the signal — so unknown names are refused.

### Why views are declarative

The activity-bar entry and the panel tab have to exist before your code has run, or there
would be nothing to click to start it. Declaring views is what lets julIDE create a
view's frame lazily, when the user first opens it, instead of every installed plugin
spinning one up at launch.

## Entry points

| Export            | Runs in              | When                                |
| ----------------- | -------------------- | ----------------------------------- |
| `activate(ctx)`   | the background frame | once, at activation                 |
| `renderView(ctx)` | each view frame      | when a declared view is first shown |

Your bundle runs in both. `ctx.view` is set only in a view frame and tells you which view
you are rendering:

```js
window.julide.renderView = async function renderView(ctx) {
  document.body.textContent = `This is the "${ctx.view.id}" view.`;
  await ctx.view.setBadge(3);
};
```

A view frame renders into its own `document` — normal DOM, all yours. It cannot register
commands or status bar items; only the background frame can, so a plugin with three views
does not register everything four times.

## `ctx`

```ts
ctx.pluginId: string
ctx.apiVersion: 2

ctx.commands.register(id, label, handler): Promise<Disposable>   // background only
ctx.commands.execute(id): Promise<void>                          // your own commands only

ctx.ui.setStatusBarItem({ id, text, tooltip?, icon?, alignment? }): Promise<Disposable>
ctx.ui.setToolbarButton({ id, label, icon, enabled?, visible? }): Promise<Disposable>
ctx.ui.showNotification(message, type?): void

ctx.workspace.getPath(): Promise<string | null>
ctx.workspace.readFile(path): Promise<string>
ctx.workspace.writeFile(path, content): Promise<void>
ctx.workspace.onDidChangeFiles(cb): Promise<Disposable>

ctx.editor.getActiveFilePath(): Promise<string | null>
ctx.editor.getSelectedText(): Promise<string | null>

ctx.ipc.invoke(command, args?): Promise<unknown>
ctx.ipc.listen(event, cb): Promise<Disposable>

ctx.view?.setTitle(title) / setBadge(badge) / onVisibilityChange(cb) / onResize(cb)

ctx.log.info(msg) / warn(msg) / error(msg)
```

Status bar items and toolbar buttons are data, not markup: text, a tooltip, an
allowlisted icon and a click. They are host chrome, and a whole sandboxed document for
the word "Ready" could not match the status bar's typography anyway.

## Permissions

Declared in `plugin.json`, approved once by the user, and checked on every call. The
catalog is in `src/services/pluginPermissions.ts`; the short version:

`workspace:read` · `workspace:write` · `julia:run` · `julia:packages` ·
`julia:configure` · `terminal` · `debugger` · `lsp` · `git:read` · `git:write` ·
`git:credentials` · `containers` · `settings:read` · `settings:write` · `pluto` ·
`dialogs`

Two rules worth knowing:

- **It fails closed.** A Tauri command not in the catalog cannot be called by any plugin
  with any permission — including every `plugin_*` command, so plugins cannot manage
  plugins.
- **Events are gated too.** `ctx.ipc.listen("julia-output")` needs `julia:run`, `pty-output`
  needs `terminal`, and so on. Listening to the output of everything the user runs is a
  read, not a lesser act.

Denials arrive as a rejected promise naming the missing permission and where to
re-approve. Branch on `err.code` — `"permission-denied"` means you did not ask for it,
`"forbidden-target"` means no permission could ever grant it.

## Approval and updates

The user approves your manifest, and the approval is bound to a fingerprint of it: name,
version, entry point, `apiVersion`, permissions **and network origins**. Change any of
those and the user is asked again rather than inheriting the old answer. That includes
adding one host to `network` without touching `permissions` — a plugin that can read the
workspace and has somewhere to send it is a different proposition from one that cannot.

Revoking in Settings takes effect immediately: the port is closed and the frame torn
down, not deferred to the next launch.

## Migrating from v1

| v1                                          | v2                                                     |
| ------------------------------------------- | ------------------------------------------------------ |
| `ctx.ui.registerSidebarPanel({ render })`   | declare it in `contributes.views`, export `renderView` |
| `ctx.ui.registerBottomPanel({ render })`    | same                                                   |
| `render(el)` with a host `HTMLElement`      | your frame's own `document`                            |
| `ctx.workspace.getPath()` → `string`        | → `Promise<string>`                                    |
| `ctx.editor.getSelectedText()` → `string`   | → `Promise<string>`                                    |
| `ctx.commands.register(...)` → `Disposable` | → `Promise<Disposable>`                                |
| `ctx.commands.execute("julia.run")`         | refused — your own commands only                       |
| `ctx.ipc.listen(any event)`                 | needs the matching permission                          |
| ES module entry                             | bundled classic script assigning `window.julide`       |
| —                                           | add `"apiVersion": 2`                                  |

`ctx.commands.execute` is the one that used to be a hole rather than a feature: it
resolved any id against the registry julIDE fills with its own commands, so a plugin
declaring nothing could call `julia.run`. It now only reaches commands you registered.

## Debugging

Anything your plugin logs, and anything it throws — including an error while your bundle
is being evaluated, before `activate` runs — is reported to the Output panel with your
plugin's name. If a plugin appears to do nothing, the usual cause is that `window.julide`
was never assigned; julIDE says so explicitly, and names what you did set.
