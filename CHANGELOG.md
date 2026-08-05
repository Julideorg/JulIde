# Changelog

All notable changes to julIDE are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
julIDE aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

First release with a stable name — the beta label is dropped. The headline change is
that julIDE now works offline; the rest is mostly security hardening and the
distribution plumbing a public release needs.

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

[Unreleased]: https://github.com/sinisterMage/julide/compare/v0.1.0-beta4...HEAD
[0.1.0-beta4]: https://github.com/sinisterMage/julide/releases/tag/v0.1.0-beta4
