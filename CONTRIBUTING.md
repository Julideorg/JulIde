# Contributing to julIDE

Thank you for your interest in contributing to julIDE! This guide will help you get set up and understand the project structure.

---

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Making Changes](#making-changes)
- [Coding Standards](#coding-standards)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Issue Guidelines](#issue-guidelines)
- [Architecture Overview](#architecture-overview)

---

## Code of Conduct

Be respectful, constructive, and inclusive. We welcome contributors of all experience levels. Harassment or discrimination of any kind is not tolerated.

---

## Getting Started

### Prerequisites

| Tool          | Version       | Installation                                      |
| ------------- | ------------- | ------------------------------------------------- |
| **Rust**      | Latest stable | [rustup.rs](https://rustup.rs/)                   |
| **Bun**       | Latest        | [bun.sh](https://bun.sh/)                         |
| **Julia**     | 1.6+          | [julialang.org](https://julialang.org/downloads/) |
| **Tauri CLI** | v2            | `cargo install tauri-cli --version "^2"`          |

**Linux only** — install system dependencies:

```bash
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libappindicator3-dev \
  librsvg2-dev \
  patchelf \
  libgtk-3-dev \
  libsoup-3.0-dev \
  javascriptcoregtk-4.1-dev
```

### Setup

```bash
git clone https://github.com/sinisterMage/JulIde.git
cd JulIde
bun install
bun run tauri dev
```

This starts the dev server with hot reload on both the frontend (Vite) and backend (Rust).

---

## Development Setup

### Running

```bash
# Full development mode (recommended)
bun run tauri dev

# Frontend only (for UI work without the native shell)
bun run dev

# Rust type-checking only
cd src-tauri && cargo check

# TypeScript type-checking only
bun run typecheck
```

### Checks

These are exactly what CI runs, so running them locally means no surprises:

```bash
bun run typecheck        # TypeScript (src/)
bun run typecheck:test   # TypeScript (tests, stories, scripts)
bun run lint             # ESLint
bun run format:check     # Prettier
bun test                 # Frontend tests
bun run test:rust        # Rust tests
bun run test:all         # Both test suites

# Auto-fix what can be fixed
bun run lint:fix
bun run format
```

Rust checks, run from `src-tauri/`:

```bash
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --all --check
```

> **NixOS:** the default PATH has no C compiler, so cargo builds fail with
> `ToolNotFound: failed to find tool "cc"`. Wrap cargo commands in a shell that
> provides the toolchain, e.g. `nix-shell -p gcc pkg-config openssl zlib glib gtk3
webkitgtk_4_1 libsoup_3 librsvg libappindicator-gtk3 --run '...'`.

### Building

```bash
# Production build
bun run tauri build

# Frontend build only
bun run build

# Rust build only
cd src-tauri && cargo build --release
```

---

## Project Structure

```
src/                          # Frontend (React + TypeScript)
├── components/               # React components, one folder per feature
│   ├── ActivityBar/           # Sidebar view switcher
│   ├── CommandPalette/        # Cmd+Shift+P command search
│   ├── Container/             # Dev container panel and container logs
│   ├── Debugger/              # Debug panel (variables, call stack)
│   ├── Editor/                # MonacoEditor, EditorTabs, Breadcrumb, etc.
│   ├── FileExplorer/          # File tree with drag-and-drop
│   ├── Git/                   # Source control panel, diff viewer, PRs/Issues tabs
│   ├── Outline/               # LSP document symbol outline sidebar panel
│   ├── OutputPanel/           # Script output with MIME rendering
│   ├── PackageManager/        # Julia package management UI
│   ├── PlotPane/              # Plot output gallery (bottom panel)
│   ├── Plugin/                # Plugin management panel
│   ├── QuickOpen/             # Fuzzy file finder (Cmd+P)
│   ├── SearchPanel/           # Global file search (Cmd+Shift+F)
│   ├── Settings/              # Preferences panel
│   ├── StatusBar/             # Bottom status indicators
│   ├── Terminal/              # Multi-terminal with xterm.js
│   ├── TestRunner/            # Julia test execution with @testset result parsing
│   ├── Toolbar/               # Run, debug, Revise, Pluto buttons
│   ├── Variables/             # Variable explorer with DataFrame viewer
│   └── Welcome/               # Welcome screen with recent projects
├── stores/                   # Zustand state stores
│   ├── useIdeStore.ts        # Main IDE state (tabs, panels, workspace, container, git)
│   ├── useSettingsStore.ts   # Persisted user settings
│   └── usePluginStore.ts     # Plugin contribution registry (commands, panels, etc.)
├── lsp/                      # LSP client and Monaco providers
├── themes/                   # Theme definitions
├── services/                 # Keybinding service, plugin host, builtin contributions
│   ├── keybindings.ts        # Keyboard shortcut manager
│   ├── builtinContributions.ts # Built-in sidebar/bottom panels and commands
│   ├── pluginHost.ts         # Plugin discovery, loading, and lifecycle
│   └── pluginContext.ts      # Sandboxed plugin API context factory
├── types/                    # TypeScript interfaces
├── App.tsx                   # Root layout
└── App.css                   # All styles (single file)

src-tauri/src/                # Backend (Rust)
├── lib.rs                    # Tauri builder, command registration
├── julia.rs                  # Julia process management
├── lsp.rs                    # LSP server bridge
├── pty.rs                    # Terminal PTY sessions
├── git.rs                    # Git operations (libgit2)
├── git_auth.rs               # PAT token storage via OS keychain
├── git_provider.rs           # Git provider trait and dispatch commands for PRs/issues/CI
├── git_github.rs             # GitHub REST API provider implementation
├── git_gitlab.rs             # GitLab REST API provider implementation
├── git_gitea.rs              # Gitea REST API provider implementation
├── container.rs              # Docker/Podman and devcontainer management
├── plugins.rs                # Plugin directory scanning and manifest loading
├── fs.rs                     # File system operations
├── search.rs                 # Workspace file search
├── watcher.rs                # File change detection
├── settings.rs               # Settings persistence
├── debugger.rs               # Debugger.jl integration
└── pluto.rs                  # Pluto.jl integration
```

### Key architectural decisions

- **Single CSS file**: All styles are in `src/App.css` using CSS custom properties for theming. This is intentional — it keeps theming centralized and avoids CSS-in-JS overhead.
- **Zustand stores**: State is split into `useIdeStore` (runtime state), `useSettingsStore` (persisted settings), and `usePluginStore` (plugin contribution registry). Zustand with Immer middleware allows mutable-style updates.
- **Tauri invoke**: Frontend communicates with Rust via `invoke()` calls (JSON-RPC over IPC). Events flow from Rust to the frontend via `emit()`.
- **No Electron**: julIDE uses Tauri 2, which bundles to ~10MB instead of ~150MB.

---

## Making Changes

### Frontend changes

1. Components go in `src/components/<FeatureName>/`.
2. If your feature needs state, add it to `useIdeStore.ts` (or `useSettingsStore.ts` for persisted settings).
3. If your feature needs a Rust backend command, add it to the appropriate `src-tauri/src/*.rs` module and register it in `lib.rs`.
4. Add styles to `src/App.css` under a clearly marked section header.

### Backend changes (Rust)

1. Add new commands as `#[tauri::command]` functions.
2. Register them in the `invoke_handler` array in `src-tauri/src/lib.rs`.
3. If you add a new module, declare it with `mod <name>;` in `lib.rs`.
4. New Cargo dependencies go in `src-tauri/Cargo.toml`.

### Adding a new Tauri command (full flow)

1. **Rust**: Define the command in the appropriate module:

   ```rust
   #[tauri::command]
   pub fn my_command(arg: String) -> Result<String, String> {
       Ok(format!("Hello {}", arg))
   }
   ```

2. **Rust**: Register in `lib.rs`:

   ```rust
   .invoke_handler(tauri::generate_handler![
       // ... existing commands
       my_module::my_command,
   ])
   ```

3. **TypeScript**: Call from the frontend:
   ```typescript
   import { invoke } from "@tauri-apps/api/core";
   const result = await invoke<string>("my_command", { arg: "world" });
   ```

---

## Coding Standards

### TypeScript / React

- Use functional components with hooks.
- Use `useCallback` and `useMemo` for expensive operations.
- Subscribe to Zustand stores with selectors: `useIdeStore((s) => s.specificField)`.
- No class components or HOCs.
- Types go in `src/types/index.ts` for shared interfaces.
- Use Lucide React for icons.

### Rust

- Follow standard Rust formatting (`cargo fmt`).
- Use `anyhow` or `String` for error types in commands.
- Use `serde` for all types that cross the IPC boundary.
- Async commands should use `tokio` where appropriate.
- Keep modules focused — one concern per file.

### CSS

- Use CSS custom properties (e.g., `var(--bg-primary)`) for all colors.
- Add a section header comment when adding new styles.
- Test both dark and light themes when modifying styles.

### Commit messages

- Use imperative mood: "Add feature", not "Added feature".
- Keep the first line under 72 characters.
- Reference issue numbers when applicable: `Fix #42`.

---

## Submitting a Pull Request

1. **Fork** the repository and create a branch from `master`:

   ```bash
   git checkout -b feature/my-feature
   ```

2. **Make your changes** following the coding standards above.

3. **Verify** — run the same checks CI will:

   ```bash
   bun run typecheck && bun run typecheck:test && bun run lint && bun run format:check && bun test
   cd src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --all --check
   ```

4. **Add tests** for behaviour you changed. Frontend tests live beside the code as
   `*.test.ts`; Rust tests go in a `#[cfg(test)]` module in the same file.

5. **Test manually** by running `bun run tauri dev` and verifying your feature works.

6. **Push** your branch and open a PR against `master`.

7. **PR description** should include:
   - A summary of what changed and why.
   - Screenshots or screen recordings for UI changes.
   - Steps to test the change.

### PR checklist

- [ ] `bun run typecheck` and `bun run typecheck:test` pass
- [ ] `bun run lint` and `bun run format:check` pass
- [ ] `bun test` passes
- [ ] `cargo test`, `cargo clippy --all-targets -- -D warnings`, and `cargo fmt --all --check` pass (if Rust changed)
- [ ] Tests added or updated for the behaviour this changes
- [ ] `CHANGELOG.md` updated under Unreleased (if user-visible)
- [ ] Tested in both dark and light themes (if UI changes)
- [ ] No hardcoded colors (use CSS variables)
- [ ] New Tauri commands are registered in `lib.rs`
- [ ] New commands that plugins may call are mapped in `src/services/pluginPermissions.ts` — the model fails closed, so an unmapped command is unreachable
- [ ] New state is added to the appropriate Zustand store

---

## Issue Guidelines

### Bug reports

Please include:

- **OS and version** (e.g., macOS 14.2, Ubuntu 22.04, Windows 11)
- **Julia version** (`julia --version`)
- **Steps to reproduce**
- **Expected behavior** vs **actual behavior**
- **Logs** from the terminal or dev console (Cmd/Ctrl+Shift+I in the app)

### Feature requests

- Describe the problem you're trying to solve, not just the solution.
- Include mockups or examples from other tools if helpful.
- Check existing issues to avoid duplicates.

---

## Architecture Overview

### Frontend-Backend Communication

```
React Component
    │
    ├── invoke("command_name", { args })  ──→  Rust #[tauri::command]
    │                                                │
    │                                                ├── Returns Result<T, String>
    │                                                │
    └── listen("event-name", callback)    ←──  app.emit("event-name", payload)
```

### Key data flows

| Feature       | Frontend → Backend                                        | Backend → Frontend                            |
| ------------- | --------------------------------------------------------- | --------------------------------------------- |
| Run Julia     | `julia_run(filePath, projectPath)`                        | `julia-output` events (stdout/stderr/done)    |
| Terminal      | `pty_write(sessionId, data)`                              | `pty-output` events                           |
| LSP           | `lsp_send_request(method, params)`                        | `lsp-notification` events                     |
| File ops      | `fs_read_file`, `fs_write_file`, etc.                     | Direct return values                          |
| Git           | `git_status`, `git_commit`, `git_push`, etc.              | Direct return values                          |
| Git Providers | `git_provider_list_prs`, `git_provider_list_issues`, etc. | Direct return values (async)                  |
| Container     | `devcontainer_up`, `container_start`, etc.                | `container-status`, `container-output` events |
| Plugins       | `plugin_scan`, `plugin_read_entry`                        | Direct return values                          |
| File watch    | `watcher_start(workspacePath)`                            | `fs-changed` events                           |

### State management

- **`useIdeStore`** — Main IDE state: workspace path, open tabs, active panel, breakpoints, debug state, terminal sessions, LSP status, container state, git provider, etc.
- **`useSettingsStore`** — Persisted settings loaded from disk: font size, theme, tab size, container runtime preferences, recent workspaces, etc.
- **`usePluginStore`** — Plugin contribution registry: commands, sidebar panels, bottom panels, status bar items, toolbar buttons. Used by builtinContributions and third-party plugins.

All stores use Zustand with Immer middleware for immutable updates with mutable syntax.

---

## Cutting a release

The updater verifies releases with its own signing key. This is **separate from OS code
signing** — in-app updates work fine on unsigned builds, so this key is required even
though julIDE ships unsigned binaries today.

### One-time setup

```bash
bun run tauri signer generate -w ~/.tauri/julide.key
```

1. Add repo secrets `TAURI_SIGNING_PRIVATE_KEY` (the contents of `~/.tauri/julide.key`)
   and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
2. Paste the printed **public** key into `src-tauri/tauri.conf.json` under
   `plugins.updater.pubkey`, replacing `REPLACE_WITH_UPDATER_PUBLIC_KEY`.

Until both are done, the `preflight` job in `.github/workflows/build.yml` fails a tag
build on purpose — `bundle.createUpdaterArtifacts` is enabled, and publishing a release
whose manifest is unsigned would silently break updates for everyone already installed.

> **Back up `~/.tauri/julide.key`.** Losing it means existing installs can no longer
> verify updates, and every user has to reinstall by hand.

### Releasing

```bash
bun run bump-version 0.2.0   # syncs package.json, Cargo.toml, tauri.conf.json
bun run check:versions       # confirms all three agree
git commit -am "Release v0.2.0"
git tag v0.2.0 && git push --tags
```

The tag triggers `.github/workflows/build.yml`, which builds all four targets, publishes a
**draft** GitHub release, and generates the `latest.json` manifest the updater polls.
Review the draft, then publish it.

Version numbers in the manifests must stay plain `major.minor.patch` — Tauri rejects
pre-release suffixes in `tauri.conf.json`. Tag as `v0.2.0-rc1` if you need one; the CI
check accepts a tag whose base version matches the manifests.

### After publishing

The [Homebrew tap](https://github.com/Julideorg/homebrew-tap) polls for the newest
published release once a day and commits the new version and DMG checksums itself. It
only ever picks up published, non-prerelease tags. To skip the wait:

```bash
gh workflow run bump-cask.yml --repo Julideorg/homebrew-tap
```

---

## Questions?

If something is unclear, open an issue or start a discussion. We're happy to help you get started.
