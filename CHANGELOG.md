# Changelog

All notable changes to julIDE are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
julIDE aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/sinisterMage/julide/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/sinisterMage/julide/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/sinisterMage/julide/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/sinisterMage/julide/compare/v0.1.0-beta4...v0.2.0
[0.1.0-beta4]: https://github.com/sinisterMage/julide/releases/tag/v0.1.0-beta4
