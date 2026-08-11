# Changelog

All notable changes to julIDE are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
julIDE aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The markdown preview learned to typeset maths and to colour the code inside fences, the
window learned to zoom, and the tab dot that has been in the markup since 0.4.0 finally
means something — which turned out to be a change to what "saved" means, not a change to
a stylesheet.

### Added

- **ASCII-only mode** — a toggle in **Settings → Appearance**, off by default.

  It turned out to be two complaints with one cause. The interface writes typographic
  punctuation — em dashes, ellipses, middots, `→`, and the Mac modifier glyphs — which
  arrives as boxes for anyone whose font, screen reader or terminal is not up for it. And
  the editor draws `!=` as `≠`, `<=` as `≤` and `->` as `→` because JetBrains Mono's
  `liga`/`calt` features were on: **the file on disk was always plain ASCII**, which is
  exactly what made that one confusing to report.

  Both now fold. The editor keeps `ccmp`, `mark` and `mkmk` on in either mode, so `\bar`
  still composes its macron — the ligature switch is not `fontLigatures: false`, which
  Monaco maps to a constant that would have silently dropped the fix for issue 8.

  What the mode does _not_ touch is the point of it: your files, terminal output,
  filenames, branch names, PR titles, Julia's own diagnostics, `\alpha`+Tab, and the body
  of a rendered markdown document, maths included. julIDE folds the text it writes, and
  nothing else. The rule is enforced rather than remembered — a guard test parses every
  source file with the TypeScript compiler and fails when a new glyph appears in a string
  literal that no fold covers, with comments excluded by construction, which matters when
  the codebase carries 12,245 `─` characters in its section separators.

  Two glyphs left rather than folded: the Outline refresh button and the breakpoint close
  button became lucide icons, which is how every other control around them was already
  drawn. Five error strings in Rust lost their arrows unconditionally, because an error
  that reaches a `title` attribute instead of a toast has no fold boundary to pass
  through. The application menu follows on the next launch — rebuilding a live menu on
  macOS also reconstructs the Edit submenu that supplies the system clipboard shortcuts.

- **Maths in the markdown preview**, via [KaTeX](https://katex.org). `$…$` and `\(…\)`
  inline, `$$…$$` and `\[…\]` for display.

  The care here went into the `$` that is _not_ maths. A price, an escaped `\$`, a
  `$PATH$` inside a code span, and a shell fence full of `$HOME` all stay literal — an
  opening `$` has to be followed by a non-space and the
  closing one preceded by a non-space, and inline maths may not span a newline, so a
  stray delimiter cannot swallow the rest of a paragraph.

  KaTeX runs on whatever a cloned repository's README happens to contain, so it runs
  bounded: `trust` off (no `\href`, `\url` or `\includegraphics`), `maxExpand` and
  `maxSize` set, and a malformed expression rendered in red in place rather than thrown.
  Nothing is fetched — the fonts are bundled, as Monaco already is, because an IDE aimed
  at HPC and air-gapped users has to typeset offline.

  **The sanitizer did not have to be relaxed to allow any of this.** KaTeX emits spans
  carrying inline `style` plus a `<math>` subtree, and `style` and `math` are both on the
  forbidden list. So the parser only ever emits an inert placeholder holding the TeX as
  text, and the typesetting happens _after_ DOMPurify has run — the same "the document
  can ask, only julIDE can create" rule the image support already follows.

- **Fenced code in the markdown preview is highlighted — by Monaco.** Not a second
  highlighter: the editor is already in the bundle, the Julia Monarch grammar is already
  registered, and `monaco.editor.colorize` paints with the _active_ julIDE theme. A
  ` ```julia ` block in a README therefore matches the file open next to it, down to the
  colour, and follows a theme switch. Every language Monaco ships comes along free,
  resolved by name, alias or extension (`julia`, `jl`, `python`, `py`, `sh`, …) from
  Monaco's own registry rather than a hand-written table that could drift from it. An
  unrecognised tag renders as plain text, exactly as before.

  `renderer.test.ts` has carried a test named "so Julia can be highlighted later" since
  the preview landed. This is later.

- **Interface zoom** — `Cmd/Ctrl+=`, `Cmd/Ctrl+-`, `Cmd/Ctrl+0`, the View menu, the
  command palette, or a control in **Settings → Appearance**. The level persists.

  This is webview zoom, so it scales the _whole_ window — activity bar, tabs, editor and
  terminal grid alike — which is what "Zoom In" does in VS Code and is not what changing
  the editor's `fontSize` does. Doing it in CSS was considered and dropped: the
  stylesheet is entirely in `px` with no `rem` anywhere, so scaling the root font size
  would move nothing, and a CSS `zoom` on the layout root puts Monaco's mouse
  hit-testing at risk for no gain. The one new ACL entry, `set-webview-zoom`, can only
  rescale the window it is already rendering in, and the value is clamped in Rust.

### Changed

- **A tab with unsaved changes now shows a dot**, where its close button normally sits,
  turning back into the close button when you point at the tab — as in VS Code.

  The dot, its CSS and the `isDirty` field have all been there since 0.4.0. Nothing ever
  set the flag to `true`: every writer passed a hardcoded `false`, so the indicator was
  unreachable and the "reload a file changed on disk unless it has unsaved work" guard
  was reading a field that was always `false`. Dirtiness is now derived in the store from
  the tab's content against what was last read from or written to disk, rather than
  supplied by whoever happened to be editing — so undoing back to the saved text clears
  the dot on its own, and no call site can forget to raise it again.

- **Auto-save is now a setting that is actually read, and it is off by default.** It has
  been in the Settings panel and in `settings.json` since 0.2.0, doing nothing: the
  editor wrote every buffer 800ms after the last keystroke regardless of it. That is also
  why "unsaved" could never mean much — nothing stayed unsaved for longer than 800ms.

  **Existing installs keep auto-save on.** `settings_save` writes every field, so every
  installed copy already has `autoSave: true` on disk and keeps it; only a fresh install
  gets the new default. Turning it off under someone who has been relying on it is a way
  to lose work, not a fix. Anyone who _did_ untick the box now gets what they asked for.

- **Closing an edited file asks first.** Closing a tab with unsaved changes — by the
  close button, by middle-click, or by quitting the app — offers Save, Don't Save and
  Cancel, and Cancel genuinely cancels the quit. This is load-bearing rather than
  decorative now that auto-save can be off: before, closing a tab could lose at most the
  last 800ms of typing; now it could lose an afternoon.

## [0.5.0] - 2026-08-10

Jupyter notebooks, without a second copy of your code: a `.jl` file with `# %%` markers
_is_ a notebook, sharing one persistent Julia kernel across its cells, and the file text
stays the only source of truth — so the language server, git diff and undo keep working as
they do in any other file. The markdown preview can show images too, behind two switches
that stay off until you turn them on.

This release also fixes two things that did not work on Windows at all. The language
server refused to start there every time, because julIDE built the URIs it sends by
pasting a path onto `file://` — which also broke any path containing a space or an accent,
on every platform. And dev containers never found Docker, because the runtime search asked
a login shell to run `which`.

### Added

- **The markdown preview can show images — two switches, both off until you turn them
  on.** **Settings → Appearance** gains _Workspace Images_ (files a document references
  by relative path) and _Remote Images_ (`https://` URLs, which is what README badges
  are). 0.4.1 shipped a placeholder in place of every image; that is still exactly what
  you get until you opt in, and it is still the default.

  Neither switch widens julIDE's content security policy, which is what made this worth
  doing carefully rather than quickly. `img-src` is still `'self' data: blob:` and
  `connect-src` still names no remote origin: the bytes are read or fetched in **Rust**
  and handed to the preview as a blob, the same "network happens outside the webview"
  rule the plugin registry already follows. The `<img>` element is created
  programmatically _after_ the document has been sanitized, so `img` and `src` remain
  forbidden in the sanitizer's allowlist — a README still cannot put an image tag on the
  page; it can only ask, and be refused.

  What is checked before any byte is read: the setting, again, in Rust — the preview is
  not the boundary. Local paths are re-resolved and canonicalized in Rust and must land
  inside the open workspace, so a symlink cannot lead out of it. Remote URLs must be
  `https`, carry no credentials, and not point at a private or loopback address;
  redirects are limited to three hops and re-checked at each one. An 8 MiB cap and a
  10-second timeout apply. Only PNG, JPEG, GIF, WebP and SVG are accepted, and the format
  is decided by the file's own magic bytes rather than its extension or the server's
  `Content-Type` — an HTML error page served as `image/png` is refused rather than
  rendered.

  **Remote images have a privacy cost, and the settings panel says so:** every badge in a
  README is a request to whoever serves it, telling them your IP address and the moment
  you opened the file — including in repositories you cloned only to read.

  SVG gets extra handling, because it is both the risky format and most of the reason to
  want this. Each one is run through DOMPurify's SVG profile — no scripts, no external
  references, no `href` of any kind — and delivered as a `data:` URL rather than a blob,
  because a blob URL is navigable and would inherit julIDE's own origin if anything ever
  opened it.

- **Jupyter notebooks, in plain `.jl` files.** julIDE now reads and runs the
  [jupytext](https://jupytext.org/) percent format: a `.jl` file with `# %%` markers _is_
  a notebook, with no separate document model and no second copy of your code. The file
  text stays the only source of truth, so the language server, autosave, git diff and
  undo all keep working exactly as they do in any other file — which is the whole reason
  to build it this way rather than as a grid of cell editors.

  **Cells share state.** A persistent Julia kernel runs behind the notebook, so `x = 1`
  in one cell is visible from the next — the thing that made the old `##` cells not
  really cells. It is a real kernel: soft scope (so a top-level `for` loop over a global
  works), multi-statement cells, `;` suppression, methods defined and used in the same
  cell, and a full MIME bundle so plots come back as images rather than as
  `Plot{...}`. Errors carry a real Julia stacktrace pointing at your own file and line.

  **Outputs render inline**, in a panel under each cell — text, images, sanitized HTML
  tables, and tracebacks. Editing a cell dims its output rather than deleting it, the way
  Jupyter does; a one-character fix should not silently discard a thirty-second plot.

  Each cell gets a **Run Cell / Run Below** toolbar and an execution count. Ctrl+Enter
  runs a cell, Shift+Enter runs it and moves on, and the command palette has the rest
  under `Notebook:` — run all/above/below, insert a cell, change a cell between code and
  markdown, interrupt, restart, clear outputs, and create a new notebook. Interrupting
  works on macOS and Linux; on Windows there is no signal that interrupts Julia without
  killing it, so the command says so and offers a restart instead of quietly doing
  nothing.

  **`.ipynb` pairing.** A header declaring `formats: ipynb,jl:percent` keeps a real
  notebook alongside the script, so outputs survive a restart and you can hand the
  `.ipynb` to someone who has never heard of julIDE. Opening an `.ipynb` opens its
  script. Outputs are matched back to cells with jupytext's own rules, so inserting,
  deleting and reordering cells does not scramble which plot belongs to which. The
  notebook is written atomically and only on an explicit save — not on the typing
  autosave, which would rewrite megabytes every second and make the file unusable in
  git. If it changed on disk underneath julIDE, the save stops and says so rather than
  overwriting someone else's work.

- **Code cells understand the jupytext percent format.** `# %%` markers now delimit
  cells, alongside the `##` separator julIDE already had — so a `.jl` file written by
  [jupytext](https://jupytext.org/), VS Code or Spyder is read as the notebook it is
  rather than as one undivided block. `# %% [markdown]`, `# %% [raw]`, cell titles,
  marker metadata, Spyder's `# %%%` sub-cells and the `# <codecell>` / `# In[1]:`
  spellings are all recognised, and the `# ---` YAML header is understood as a header
  rather than treated as code.

  The parser round-trips byte for byte, which is what will let a later change edit one
  cell without reformatting the rest of the file.

### Changed

- **Dev containers work on Windows.** Several things stood between the feature and that
  platform, and they had to be fixed together to be worth anything.

  Docker was never found. The runtime search asked a login shell to run `which`, then
  looked in `/usr/bin`, `/usr/local/bin` and `/opt/homebrew/bin` — a search that cannot
  succeed on Windows, so the panel reported no runtime installed on machines running
  Docker Desktop. It now uses `where.exe` and falls back to the CLI's location under
  `%ProgramFiles%`, which is where it sits before a logout puts it on `PATH`.

  Every call flashed a console window. Julia, the language server and Pluto all suppress
  that; this module did not, so listing containers or opening the panel blinked a black
  box each time.

  `initializeCommand` ran through `sh -c`, which does not exist on Windows. It now uses
  the host's shell — and, on Windows, passes the command line verbatim rather than
  through Rust's argument quoting, which `cmd.exe` does not follow.

  A workspace on a UNC path (`\\wsl$\...`, a network share) was handed to the runtime as
  a bind-mount source it cannot resolve, and the resulting failure named neither the path
  nor the reason. That is now refused up front, with the reason.

- **"Run" inside a dev container executes the file that is open.** It was sending the
  container the path the file has on _your_ machine — `docker exec … julia
/home/you/proj/a.jl` for a project mounted at `/workspace`. This is a Windows bug and
  more, since it was wrong on Linux and macOS too any time `workspaceFolder` was not the
  host path, which is the default. Host paths are now translated onto the mount point.
  The container terminal opens in the project for the same reason, rather than wherever
  the image's `WORKDIR` pointed.

- **The Container panel distinguishes "not installed" from "not running".** Docker
  Desktop does not start with the session on Windows, and being told to install software
  you already have is not a useful next step. It now says which one it is.

### Fixed

- **The language server no longer refuses to start on Windows, or under any path with a
  space or an accent in it.** On Windows it failed every time, with
  `[Fatou] Fatou language server stopped: unexpected character at index 9`
  ([#38](https://github.com/Julideorg/JulIde/issues/38)) — and index 9 is the giveaway.
  julIDE built the URIs it sends the server by pasting the path onto a prefix,
  `` `file://${path}` ``. For `C:\Users\you\project` that produces
  `file://C:\Users\you\project`, where a URI parser reads `C:` as a hostname, waits for a
  port number, and finds a backslash — the tenth character. Fatou parses every URI
  strictly, so the handshake failed and the server exited before it had answered anything.

  The same paste broke a path containing a space, `#`, `%` or a non-ASCII character on
  every platform, for the same reason: none of those are characters a URI may carry
  as-is. `/home/joão/My Project` failed exactly like the Windows path did, just at a
  different index.

  Paths are now converted properly — drive letters, UNC shares, separators and
  percent-encoding — by one function with tests, rather than by string concatenation in
  the seventeen places that had grown a copy of it. The editor's own document identity was moved onto the same conversion,
  which is what makes inline diagnostics attach to the right file on Windows; before, the
  editor and the server disagreed about what a document was called, so squiggles had
  nowhere to land even when the server did survive.

- **A `##` heading inside a docstring no longer splits a code cell.** Cell detection was
  a plain "does this line start with `##`" scan, so a docstring containing a Markdown
  heading — `"""\n## Examples\n"""` — cut the cell in two and Ctrl+Enter ran only part of
  it. Scanning is now aware of Julia strings and of nested `#= =#` block comments. For
  the same reason, `##` no longer splits cells in a file that uses `# %%` markers, where
  an ordinary `## TODO` comment previously would.
- **Ctrl+Enter and gutter breakpoints acted on the wrong file after switching tabs.** The
  editor is mounted once and reused across tabs, so both handlers were still holding the
  tab that happened to be open when the editor first mounted. Breakpoints were toggled
  against that file's path, and cell execution silently did nothing if the original tab
  was not a `.jl` file. Both now read the active tab at the moment they run, the way the
  save path already did.
- **Running a code cell leaked an event listener every time.** The `julia-output`
  subscription was only torn down on successful completion, so any run that errored left
  it attached for the rest of the session — and every surviving listener then also
  received later runs' output, appending it to a dead cell's inline result. There is now
  one subscription for the app's lifetime.
- **"Run Code Cell" in the command palette opened the autocomplete popup** instead of
  running the cell. It now shares the Ctrl+Enter implementation.
- **The Activity Bar Labels setting reset itself on every restart.** It existed on the
  TypeScript side only, and `settings_save` writes the whole settings struct — so the
  field was silently dropped on each write. It now persists.
- **Quitting julIDE could leave orphaned Julia processes.** Nothing dropped the session
  registry at exit, so `kill_on_drop` never fired. Kernels are now reaped on the app's
  exit event.

## [0.4.1] - 2026-08-09

Markdown files can be read as well as edited. Dropdown menus finally follow the theme on
every platform, and the Output panel no longer locks up under a talkative Julia program —
which turns out to have been the same bug that was reddening CI.

### Added

- **Markdown preview.** `.md` files can now be rendered instead of only edited, either in
  place — the eye button on the tab flips between source and preview — or side by side via
  **View → Open Markdown Preview to the Side**. Both are in the command palette as
  `Markdown: …`. The preview follows the editor as you type, and it is themed from the
  same design tokens as the rest of the IDE, so it reads correctly in both light and dark.

  Toggling in place keeps the editor mounted rather than tearing it down, so undo history,
  cursor and scroll position all survive the round trip. That also closes a data-loss hole
  that the obvious implementation would have opened: unmounting the editor discards its
  pending autosave, and since typing does not mark a tab dirty there would have been
  nothing to indicate the write never landed.

  Links behave the way you would want and no way you would not. External links open in
  your browser rather than navigating the IDE away from itself; a relative link to another
  `.md` file opens it as a tab, in preview; `#heading` links scroll. A link that resolves
  outside the workspace is refused with a note rather than followed — a README usually
  arrives with a cloned repository, and the file-reading command behind it has no path
  restriction of its own.

  Two deliberate limits, both visible: **images do not render**, because julIDE's content
  security policy permits neither remote images nor local file reads for them, so a
  placeholder naming the missing image is shown instead of a broken-image icon. And **raw
  HTML written inside a markdown file is shown as text rather than rendered**, which will
  look wrong on READMEs that lean on `<details>` or inline HTML. That is the safer default
  while the sanitizer allowlist gets some mileage; it is a small change to revisit.

### Fixed

- **Dropdown menus follow the IDE theme.** Every dropdown in julIDE was a native
  `<select>`, and while the closed control was themed, the popup list is drawn by the
  platform rather than the page — so it stayed white in dark mode everywhere. Two changes
  fix it: the generated design tokens now declare `color-scheme` per theme, which also
  brings scrollbars, spinners, checkboxes and the caret into line on every platform; and
  the eleven native selects are replaced with a themed listbox (`ui/Select`) built on the
  same anchored-surface machinery as `ui/Popover`. The component was necessary rather than
  optional because on Linux/WebKitGTK the `<select>` popup is a native GTK menu living
  outside the DOM, which no CSS — `color-scheme` included — can reach. It implements the
  ARIA select-only combobox pattern, so arrow keys, Home/End, type-to-select, Enter, Tab
  and Escape all behave, and a test now fails the build if a native `<select>` reappears.
- **The Output panel no longer freezes when Julia produces sustained output.** `appendOutput`
  pushed each line into an immer draft, and with auto-freeze on that deep-froze the entire
  retained buffer once per line — quadratic work that took **30 seconds** for 5000 lines
  once the 5000-line cap was reached. The buffer is now kept on a plain copy-on-write path
  outside immer, which does the same work in about 20ms. `appendContainerLog` had the same
  bug and the same fix. This is also what had been failing CI: the store's own truncation
  test exceeded the 5s per-test budget on the runner.
- **No more light flash on startup.** The theme class was only applied to `<html>` after
  React mounted, so the first paint had no theme at all.

## [0.4.0] - 2026-08-09

Plugins now run in a sandbox. Before this release a plugin was evaluated in julIDE's own
realm, where it reached `window.__TAURI_INTERNALS__` and through it every Tauri command,
with no declared permission at all — the permission system existed, but nothing stopped a
plugin from going around it. This release closes that, and adds a signed registry to
install from.

**This is a breaking change for plugin authors.** Plugins built against the v1 API are
refused, with an explanation rather than a silent half-failure. See
[docs/PLUGIN_API_V2.md](docs/PLUGIN_API_V2.md) for the migration.

### Added

- **Plugins run in an isolated frame.** Each plugin gets an
  `<iframe sandbox="allow-scripts">` — no `allow-same-origin`, so the frame has an opaque
  origin — served over a custom `julide-plugin://` scheme. The scheme is what makes this
  possible at all: a per-plugin CSP has to arrive as a real response _header_, and a
  `srcdoc`, `blob:` or `<meta>` document cannot carry one. (A frame created from those
  inherits the embedder's policy container, and `'self'` inside an opaque origin matches
  nothing — so such a frame either runs no script at all, or runs only because the main
  realm's `script-src` was loosened, which is the exact capability this removes.) Inside
  the frame there is no Tauri bridge, no parent DOM, and no origin storage; every
  capability a plugin has arrives over a `MessagePort` the host hands it after a
  handshake, and if a method is not in the dispatcher the plugin cannot do it.
- **The sandbox checks itself.** On handshake the frame reports whether the Tauri bridge
  is absent, the origin is opaque, storage is blocked and the CSP was applied. A frame
  that fails any of those — or that does not report at all — is torn down instead of
  being trusted. So a regression that quietly re-opened the sandbox would surface as a
  plugin refusing to load, rather than as nothing at all.
- **Per-plugin network policy.** A plugin declares the origins it needs in `plugin.json`
  and gets exactly those in its frame's `connect-src`; declaring none means
  `connect-src 'none'`. Wildcard subdomains, bare schemes, paths, credentials and
  non-loopback `http://` are all rejected — each is a form a hostile manifest would like
  accepted and none has an honest use an explicit origin does not cover. Rust re-validates
  rather than trusting what the frontend passes it. This only became enforceable once
  plugins had their own frame: previously everything shared julIDE's CSP, so widening
  egress for one plugin widened it for every plugin and for the IDE itself.
- **A permission catalog and a consent flow.** `permission-catalog.json` is generated from
  the source of truth and checked in CI, so it cannot drift from what the code actually
  enforces; it is also what the registry reads to describe a plugin's requests. The
  consent dialog shows the permission table before anything is created for the plugin —
  decline and its code is never fetched, let alone evaluated — and a stored grant that no
  longer covers the manifest re-prompts.
- **A signed plugin registry, and a browser for it in Settings.** The index is verified
  with minisign in Rust, never in the webview, and every download is checked against the
  sha256 the signed index names. Signing rather than trusting TLS is the point: otherwise
  whoever controls the host controls the digest, and the digest would only prove "I
  downloaded what the host meant to send". The registry key is deliberately _not_ the
  Tauri updater key — sharing them would turn a registry compromise into an app-update
  compromise. The registry commands are deliberately absent from the permission catalog:
  a plugin that can install plugins is privilege escalation with no legitimate use.
- **A revocation feed**, refreshed at startup and every six hours and applied before a
  plugin loads. It fails _open_ on a network error — an IDE that will not load plugins on
  a plane is worse than the exposure window — and _closed_ on a signature failure, keeping
  the last verified copy. Two limits are worth stating plainly: it matches on the name and
  version in the plugin's own manifest, so a deliberately malicious sideloaded plugin
  renames itself past it, and it is a mitigation for supply-chain compromise of a registry
  plugin the user chose to trust — not a defence against hostile local files.

### Changed

- **Plugin API v1 is no longer loaded.** v1 handed plugins a live `HTMLElement` from
  `render(el)` and a synchronous `ctx`, neither of which can cross a frame boundary. Views
  are now declared in `plugin.json` instead, which is also what lets a view frame be
  created lazily on first show rather than every plugin spinning one up at startup.
- CI now fails when a generated file is stale — `permission-catalog.json` and the plugin
  bootstrap are both things a plugin depends on being accurate, and a stale one is silent
  by construction.

### Fixed

- **An unreachable plugin registry no longer looks like something is broken.** "Not
  published yet" and "your network is down" are both ordinary, and neither is a fault in
  julIDE, so they now read as informational and say that hand-installed plugins still
  work. A signature that fails to verify keeps the warning — that one is worth reporting.

## [0.3.1] - 2026-08-08

A maintenance release. julIDE now starts on Linux machines where WebKitGTK could not
allocate a DMA-BUF and the window silently never appeared, and the dependency stack was
brought up to date — which also cleared every advisory `cargo audit` was reporting.

### Fixed

- **julIDE no longer fails to open a window on Linux systems where WebKitGTK cannot
  allocate a DMA-BUF.** The symptom was the app simply never appearing, with nothing
  but `libEGL warning: …` on stderr to explain it, and it hit NVIDIA proprietary
  drivers under Wayland, WSL, and VMs and containers without a working DRI render
  node ([#36](https://github.com/Julideorg/JulIde/issues/36)). julIDE now sets
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` for itself at startup, so WebKit uses
  shared-memory buffers instead — a small compositing cost on machines where DMA-BUF
  would have worked, in exchange for starting on the ones where it does not. The
  default is applied in-process rather than in packaging, so the .deb, .rpm,
  AppImage, distro and source builds all behave the same. Setting the variable
  yourself still wins; `WEBKIT_DISABLE_DMABUF_RENDERER=0 julide` opts back into the
  accelerated path.
- **The macOS build compiles again.** `Cargo.lock` pinned `zune-core` 0.5.2, which has
  since been yanked: its logging macros expanded to nothing, so `zune-jpeg`'s
  `warn!(…)` in trailing-expression position was not an expression at all and failed
  to compile. A lockfile keeps resolving a yanked version, so nothing surfaced until a
  build actually reached that crate — and only macOS does, through
  `tauri-plugin-clipboard-manager` → `arboard` → `image` → `tiff`. Updating to 0.5.3,
  where the macros expand to a block, fixes it.

### Security

- **Cleared every advisory `cargo audit` was reporting as a vulnerability.** Three
  transitive crates were affected: `quick-xml` (quadratic parse time on duplicate
  attribute names, and unbounded namespace allocation — RUSTSEC-2026-0194/0195),
  `quinn-proto` (remote memory exhaustion via out-of-order stream reassembly —
  RUSTSEC-2026-0185), and `rustls-webpki` (three certificate-validation issues —
  RUSTSEC-2026-0098/0099/0104). All are lockfile-only updates. The remaining audit
  output is unmaintained/unsound warnings for the GTK3 binding stack, which Tauri
  pins and julIDE cannot move on its own.

### Changed

- **Rust dependencies refreshed**, including `tauri` 2.11.5, `tauri-build` 2.6.3,
  `anyhow` 1.0.104, `uuid` 1.24, `serde_json` 1.0.151 and `regex` 1.13.
- **The npm side of Tauri was brought back in line with the crates** —
  `@tauri-apps/api` 2.10.1 → 2.11.1, `@tauri-apps/cli` 2.10.1 → 2.11.4, and
  `@tauri-apps/plugin-opener` 2.5.3 → 2.5.4. The Rust bump above had moved `tauri` to
  2.11.5 on its own, and the CLI refuses to build when the crate and
  `@tauri-apps/api` differ in major or minor, so every platform failed at the very
  start of `tauri build`. CI never caught it because `ci.yml` does not run a bundle
  build.
- **The Rust toolchain is now genuinely pinned, to 1.95.0.** `rust-toolchain.toml`
  said `channel = "stable"`, which pins nothing — each CI run took whatever stable
  had become that day, and the compiler a contributor saw locally had no relation to
  the one that built the release. The workflows pin the same version explicitly,
  because `dtolnay/rust-toolchain` cannot read the toml and the macOS cross-compile
  target has to be installed onto the toolchain cargo actually uses. The audit job is
  left floating on purpose: it never compiles julIDE, so pinning it would only risk
  `cargo-audit` outgrowing the pinned compiler. This is reproducibility hygiene, not
  a fix for anything.
- **`git2` 0.20 → 0.21**, which also clears two unsound advisories
  (RUSTSEC-2026-0183/0184). The release makes several APIs fallible —
  `Commit::summary()`, `Remote::url()` and `Reference::shorthand()` now return
  `Result`, `BlameHunk::final_signature()` returns an `Option`, and `StringArray`
  iterates `Result<Option<&str>>`. Call sites in `git.rs` and `git_provider.rs` were
  updated; blame hunks with no signature now fall back to an "Unknown" author rather
  than being dropped, which would have misaligned the blame gutter.
- **`monaco-editor` 0.55 → 0.56.** The package gained an `exports` map, so the
  worker entry points moved from `monaco-editor/esm/vs/…` to `monaco-editor/…`.
  Without that change the production build fails to resolve any of the five workers.
- **`lucide-react` 0.577 → 1.x** and **TypeScript 5.8 → 6.0**.
- **Storybook 8 → 10.** `addon-essentials` and `addon-interactions` stopped
  publishing at 9 — controls, backgrounds and the toolbar now ship in core, so both
  were dropped. `backgrounds.values` became `backgrounds.options`, and the initial
  theme moved from `globalTypes[].defaultValue` to `initialGlobals`. `main.ts` is
  also loaded as real ESM now, so `__dirname` had to be derived from
  `import.meta.url`.
- **GitHub Actions bumped:** `actions/checkout` 4 → 7, `actions/upload-artifact`
  4 → 7, and `tauri-apps/tauri-action` 0 → 1. The last one renames
  `includeUpdaterJson` to `uploadUpdaterJson`; the old name is no longer an input, so
  leaving it would have silently stopped generating `latest.json` and broken in-app
  updates for existing installs.

## [0.3.0] - 2026-08-06

Two big changes: the interface was rebuilt on a design system, and the language server
is now built into julIDE instead of being something you have to install.

### Added

- **Fatou is the built-in language server, and the new default.**
  [Fatou](https://github.com/jolars/fatou) is a Julia language server, formatter, and
  linter written in Rust. It is compiled into julIDE and runs inside its own process
  over an in-memory channel — there is no package to install, no subprocess to spawn,
  no `PATH` to search, and no multi-minute indexing pass on first open. That also
  removes the class of connection failures that made an external server unreliable,
  most visibly on Windows.

  Fatou never runs Julia, which is the trade-off: it cannot infer types and does not
  know the symbols of your installed dependencies. LanguageServer.jl and JETLS.jl
  remain available under Settings → Julia → Language Server, and switching now
  restarts the server in place instead of requiring you to reopen the workspace.

- **A unified command bar** replacing the separate command palette and file finder.
  It uses Julia's own REPL grammar, so the prefix selects the mode: `]` packages,
  `?` documentation lookup, `;` shell, `>` commands, `@` symbols, `#` problems, and
  bare text finds files. Results are fuzzy-matched and ranked.
- **Formatting through the language server** — format document, format selection, and
  an optional format-on-save. With Fatou this needs no formatter package installed.
  Line width and indent width are configurable, and a project `fatou.toml` overrides
  them.
- **Workspace linting** — a Lint Workspace command that checks every `.jl` file in the
  project and fills the Problems panel, not just the files you happen to have open.
- **Toast notifications.** Uncaught async failures used to go only to the Output panel,
  which helped nobody who was not already looking at it. They now raise a toast, and
  are still mirrored to Output so there is a scrollback record.
- **Fonts are bundled.** The theme previously just _named_ JetBrains Mono and Fira Code
  and hoped one was installed; on a stock Linux or Windows machine the editor fell back
  to the OS monospace. IBM Plex Sans and JetBrains Mono now ship with the app, which
  matters for a language whose users type `α`, `∑`, and `∇` as ordinary identifiers —
  and for the offline and air-gapped setups julIDE targets.

### Changed

- **The UI was rebuilt on a design system.** A single 4,400-line `App.css` is now a set
  of per-area stylesheets over a generated design-token layer, and shared primitives
  (Button, Dialog, Field, Panel, Popover, Toast) replace the ad-hoc markup each panel
  had grown. The Welcome screen, activity bar, status bar, and themes were reworked on
  top of it.
- The window now paints its background colour before the webview loads, instead of
  flashing white on launch.
- The status bar names the active language server, so it is clear which backend is
  answering.

### Fixed

- **Editor language features worked again.** Completion, hover, go-to-definition, find
  references, rename, code actions, and inline diagnostic squiggles had all been
  unreachable since 76110f4, which removed the only code that registered them while
  trimming per-tab work. They are registered once at startup now, so the fix costs
  nothing on the path that regression was trying to speed up.
- Language features are requested only when the server actually advertises them, rather
  than assumed. Semantic highlighting also uses the legend the server reports instead of
  a hard-coded one, which would have mis-coloured tokens under any backend that did not
  happen to match it.
- `JULIA_LOAD_PATH` was built with a hard-coded `:` separator. On Windows — which splits
  on `;` — that collapsed the whole value into one unusable entry immediately after the
  drive letter, so the workspace project silently failed to load.
- A language server that failed to start left the status stuck on "starting", and the
  guard against double-starting then refused every retry for the rest of the session.
- Stopping the server no longer reports it as having crashed.
- Ctrl+S saved whichever file was open when the editor first mounted, not the one you
  were actually looking at.

### Internal

- Frontend tests: 176 → 223. Rust tests: 113 → 127, including a real Fatou handshake and
  document-lifecycle test driven in-process — no toolchain, no binary, no Julia.
- `bun run typecheck:test` passes again; a `test.each` table had been failing type
  checking, so that CI step was red.

## [0.2.0] - 2026-08-05

First release with a stable name — the beta label is dropped. The headline change is
that julIDE now works offline; the rest is mostly security hardening and the
distribution plumbing a public release needs.

> Released as `v0.2.0` but shipped with the manifests still reading `0.1.0`; the version
> bump was missed. Corrected in 0.3.0.

### Fixed

- **julIDE now works without an internet connection.** Monaco was being fetched from a
  CDN at runtime, so the editor silently failed to load with no network. It is now
  bundled with the application.
- **Windows and macOS installers are produced again.** The bundle target list had been
  narrowed to Debian only, so those platforms built successfully and published
  nothing. CI now fails loudly instead of uploading an empty artifact set.
- Deleting a file whose name contained HTML executed it — the confirmation dialog
  interpolated the filename into `innerHTML`. It also now responds to Enter and
  Escape, and restores focus when dismissed.
- Personal access tokens could be sent in cleartext to any host named by a
  repository's `origin`. API endpoints derived from a remote are now forced to
  `https` for every non-loopback host.
- A pasted access token containing a stray control character crashed the app instead
  of reporting an error.
- The debugger could spin forever when a subprocess repeatedly failed to produce
  output.
- A panic while holding one of the terminal, container, or debugger registries left
  that subsystem permanently broken until restart.
- Opening a recent project whose directory had been deleted did nothing at all, with
  no message and no way to clear the dead entry.
- Settings written with an out-of-range value (a hand-edited `fontSize` of 99999, a
  `plutoPort` of 0) no longer make the app unusable — values are clamped on load and
  save, and settings are written atomically so an interrupted write cannot truncate
  the file.

### Added

- **In-app updates.** julIDE checks for new releases and can update itself.
  AppImage, macOS, and Windows builds update in place; `.deb`/`.rpm` installs are
  owned by the system package manager, so those are told a new version exists and
  linked to the download.
- **Guided first-run setup.** If Julia is missing, julIDE now offers to download it,
  locate an existing install, or re-check — instead of showing a line of gray text.
  Once Julia is found it offers one-click installs for LanguageServer, Revise,
  Debugger, and Pluto.
- **A permission model for plugins.** Plugins declare what they need in
  `plugin.json`, the user approves it once, and every backend call is checked against
  that grant. Approvals are bound to a fingerprint of the manifest, so an updated or
  swapped plugin re-prompts. Grants are revocable under Settings → Plugins.
- **Workspace trust for dev containers.** A `devcontainer.json` can declare an
  `initializeCommand`, which the spec runs on the host. julIDE now shows exactly which
  commands would run, and which of them run outside the container, before starting.
- **A native application menu**, including the standard macOS Edit menu — which is
  what makes system clipboard shortcuts work there.
- **Window and layout persistence.** Window size and position, sidebar width, and
  bottom-panel height survive a restart.
- Error boundaries: a crash in one panel no longer blanks the whole window, and
  uncaught async failures are reported instead of vanishing into a console nobody sees.
- A Content-Security-Policy, and `.desktop`/AppStream metadata so julIDE can be the
  default `.jl` handler and appear correctly in Linux software centres.
- Settings can be reset to defaults, and a failed save is now visible rather than
  silent.

### Changed

- Plugins no longer receive unrestricted access to the backend.
- The webview's permissions were narrowed: the shell and filesystem plugin APIs are no
  longer exposed to it at all, since nothing used them.
- The Julia interpreter path is verified before being adopted — a binary that does not
  identify itself as Julia is rejected rather than silently used for every run.
- Settings are written on a short debounce instead of on every keystroke.
- Dependencies: replaced the unmaintained `dirs-next`, updated `git2`, `notify`, and
  `portable-pty`, and trimmed the Tokio feature set.

### Internal

- CI now runs on every push and pull request: typecheck, lint, format check, tests,
  clippy, and `cargo fmt --check`. Previously nothing ran automatically at all.
- Added ESLint and Prettier, which had never been configured despite the codebase
  carrying suppression comments for them.
- Test and story files are now type-checked; they were excluded before, which had
  hidden a broken test helper.
- Frontend tests: 103 → 176. Rust tests: 73 → 113.

---

## [0.1.0-beta4] - 2026-03-27

Earlier beta releases were not accompanied by a changelog. See the
[releases page](https://github.com/sinisterMage/julide/releases) for their notes.

[Unreleased]: https://github.com/Julideorg/JulIde/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/Julideorg/JulIde/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/Julideorg/JulIde/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Julideorg/JulIde/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/sinisterMage/julide/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/sinisterMage/julide/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/sinisterMage/julide/compare/v0.1.0-beta4...v0.2.0
[0.1.0-beta4]: https://github.com/sinisterMage/julide/releases/tag/v0.1.0-beta4
