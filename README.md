# julIDE

A modern, fully-featured IDE for the [Julia](https://julialang.org/) programming language, built with [Tauri 2](https://tauri.app/), React, TypeScript, and Rust.

![License](https://img.shields.io/badge/license-MIT-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)
![Julia](https://img.shields.io/badge/Julia-1.6%2B-9558B2)
<img width="2553" height="1353" alt="image" src="https://github.com/user-attachments/assets/29f6e9da-70d3-4e0c-a550-d85903ee63ed" />

---
## Credits

[@ Rakesh ](https://github.com/rakeshksr) - conributed multiple bug fixs and featue suggestions 🎉

[@ RockyBeast](https://github.com/rokybeast) - contributed the new julIDE icons 🎉

---

## Features

### Code Editing
- **Monaco Editor** with full Julia syntax highlighting via a custom Monarch tokenizer
- **25+ Julia snippets** — function, struct, try/catch, @testset, comprehensions, macros, and more
- **Tabbed multi-file editing** with dirty indicators and auto-save
- **Split editor** — side-by-side editing with a resizable divider
- **Breadcrumb navigation** showing the file path below the tab bar
- **Find & Replace** (Cmd/Ctrl+F, Cmd/Ctrl+H) via Monaco's built-in widget
- Configurable font size, font family, tab size, word wrap, and minimap
- **LaTeX to Unicode** — type `\alpha` + Tab to insert `α` (based on Julia's LaTeX symbols table)

### Language Intelligence (LSP)
- Powered by [LanguageServer.jl](https://github.com/julia-vscode/LanguageServer.jl)
- **Autocompletion**, **hover documentation**, **go-to-definition**, **find references**
- **Signature help** with parameter info
- **Real-time diagnostics** (errors and warnings) shown inline and in the Problems panel
- **Error lens** — inline diagnostic messages displayed at the end of each line
- **InlayHints** — type and parameter hints displayed inline in the editor
- **Semantic tokens** — rich semantic highlighting beyond syntax-level tokenization
- **Workspace and document symbol search**

### Julia Runtime
- **Run scripts** with rich output — inline images (PNG, JPEG, SVG), HTML, and plain text
- **Interactive REPL** via xterm.js with full PTY emulation
- **Multi-terminal support** — create, switch, and close multiple Julia REPL sessions
- **Debugger** integration via [Debugger.jl](https://github.com/JuliaDebug/Debugger.jl) — breakpoints, step-through, variable inspection, call stack
- **Code cell execution** — `##` markers create code cells; `Ctrl/Cmd+Enter` runs the current cell with inline results
- **Variable Explorer** — workspace variable introspection via the REPL with DataFrame viewer support
- **Revise.jl** toggle for hot-reload development
- **Pluto.jl** reactive notebook support — open `.jl` files as Pluto notebooks in a native window
- **Package Manager** — add and remove packages via `Pkg.jl` directly from the UI
- **Environment selector** — switch between Julia project environments

### File Management
- **File explorer** with tree view, create/rename/delete files and folders
- **Drag-and-drop** to move files between directories
- **File watching** — automatically detects external changes (git, other editors) and refreshes the tree
- **Quick Open** (Cmd/Ctrl+P) — fuzzy file finder across the entire workspace
- **Global Search** (Cmd/Ctrl+Shift+F) — search across all files with regex, case-sensitivity, and glob filters

### Git Integration
- **Source control panel** — view staged, unstaged, and untracked files
- **Stage / unstage** individual files or stage all at once
- **Commit** with a message directly from the UI
- **Branch management** — create, delete, and switch branches from the UI
- **Push / Pull / Fetch** — sync with remote repositories
- **Merge** — fast-forward and normal merges with conflict detection
- **Stash** — save, list, and pop stashed changes
- **Ahead/Behind tracking** — see how far your branch is from the upstream
- **GitHub / GitLab / Gitea** provider integration — browse PRs, issues, and CI status directly in the IDE
- **Auth settings** — store personal access tokens securely via the OS keychain
- **Git blame** — toggle inline blame annotations showing author, date, and commit summary per line
- **Diff viewer** — side-by-side diff view using Monaco DiffEditor
- **Merge conflict resolution** — detects conflict markers and provides "Accept Current", "Accept Incoming", and "Accept Both" action buttons inline
- Powered by `libgit2` (via the `git2` Rust crate) — no shell dependency for core operations

### Workspace & UI
- **Activity bar** — switch between Explorer, Outline, Search, Variables, Source Control, and Dev Containers views
- **Command palette** (Cmd/Ctrl+Shift+P) with 35+ commands
- **Settings panel** (Cmd/Ctrl+,) — configure editor, terminal, and appearance
- **Theme support** — Dark and Light themes with full CSS variable system
- **Welcome screen** with recent projects on startup
- **Resizable panels** — sidebar and bottom panel with drag handles
- **Outline panel** — LSP-powered document symbol tree in the sidebar (functions, structs, modules, etc.)
- **Variable Explorer** — workspace variable introspection in the sidebar with DataFrame viewer
- **Plot Pane** — image gallery in the bottom panel for plot output (PNG, JPEG, SVG, HTML)
- **Test Runner** — runs `Pkg.test()` and parses `@testset` results in the bottom panel
- **Status bar** — Julia version, environment, git branch, LSP status, Revise/Pluto indicators

### Dev Container Support
- **Auto-detect** `devcontainer.json` in the workspace and offer to build/start
- **Docker and Podman** runtime auto-detection (with manual override in settings)
- **Build, start, stop, rebuild, and tear down** dev containers from the UI or command palette
- **Container panel** in the sidebar — list running containers and images, start/stop/restart/remove
- **Container logs panel** — stream and view container output in real time
- **Container terminal** — open a PTY session inside the running container
- **Run Julia inside the container** — execute scripts in the dev container environment

### Plugin System
- **Plugin discovery** — automatically scans `~/.julide/plugins/` for installed plugins
- **Plugin manifest** (`plugin.json`) — declare name, version, entry point, contributions, and permissions
- **Plugin API** — register commands, sidebar panels, bottom panels, status bar items, and toolbar buttons
- **Permission model** — plugins declare the capabilities they need and the user approves them once; every backend call is checked against that grant
- **Plugin panel** in the activity bar sidebar — view installed plugins, their status, and their granted permissions

#### Plugin permissions

Plugins are unsigned third-party code that runs inside julIDE, so they must declare
what they need in `plugin.json`:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "displayName": "My Plugin",
  "main": "index.js",
  "permissions": ["workspace:read", "julia:run"]
}
```

On first load julIDE shows what the plugin is asking for and why it matters; declining
means the plugin is not executed at all. Approvals are tied to a fingerprint of the
manifest, so bumping the version, changing the entry point, or requesting one more
permission all re-prompt rather than inheriting the old approval. Grants are revocable
under **Settings → Plugins**.

The model **fails closed**: a call to a backend command whose permission was not
granted is rejected before it reaches the backend, and commands absent from the
catalog cannot be called at all.

| Permission | Grants |
|---|---|
| `workspace:read` | Read files and list directories |
| `workspace:write` | Create, edit, rename, delete files |
| `julia:run` | Execute Julia code |
| `julia:packages` | `Pkg.add` / `Pkg.rm` |
| `julia:configure` | Change the Julia interpreter, scaffold projects |
| `terminal` | Open PTY sessions and write to them |
| `debugger` | Breakpoints, stepping, variable inspection |
| `lsp` | Send LanguageServer.jl requests |
| `git:read` | Status, diff, log, branches, blame, PRs, issues |
| `git:write` | Stage, commit, branch, merge, stash, push, pull |
| `git:credentials` | Read and modify stored access tokens |
| `containers` | Docker/Podman and dev container control |
| `settings:read` / `settings:write` | Read / modify julIDE preferences |
| `pluto` | Start and stop the Pluto notebook server |
| `dialogs` | Native file and folder pickers |

`workspace:write`, `julia:run`, `julia:configure`, `terminal`, `git:write`,
`git:credentials`, and `containers` are flagged **high risk** in the consent prompt —
each can lead to arbitrary code execution, credential disclosure, or data loss.

---

## Prerequisites

- **Julia** 1.6 or later ([download](https://julialang.org/downloads/))
- **Rust** (latest stable) — [install via rustup](https://rustup.rs/)
- **Bun** — [install](https://bun.sh/) (used as the package manager and script runner)
- **System dependencies** for Tauri — see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

### Recommended Julia packages

Install these globally for the best experience:

```julia
using Pkg
Pkg.add("LanguageServer")  # LSP support
Pkg.add("Revise")          # Hot-reload
Pkg.add("Debugger")        # Debugger integration
Pkg.add("Pluto")           # Reactive notebooks
```

---

## Getting Started

### Clone and install

```bash
git clone https://github.com/sinisterMage/JulIde.git
cd JulIde
bun install
```

### Development

```bash
# Start the Tauri dev server (frontend + native window with hot reload)
bun run tauri dev
```

This starts Vite on `localhost:1420` and opens the native Tauri window. Changes to both the React frontend and Rust backend are hot-reloaded.

### Production Build

```bash
# Build the distributable application
bun run tauri build
```

The output is placed in `src-tauri/target/release/bundle/` and includes platform-specific installers (`.dmg` on macOS, `.msi`/`.exe` on Windows, `.deb`/`.AppImage` on Linux).

---

## Architecture

```
julIDE
├── src/                        # React + TypeScript frontend
│   ├── components/             # UI components
│   │   ├── ActivityBar/        # Sidebar view switcher
│   │   ├── CommandPalette/     # Cmd+Shift+P command search
│   │   ├── Debugger/           # Debug panel (variables, call stack)
│   │   ├── Editor/             # Monaco editor, tabs, breadcrumb, split view
│   │   ├── FileExplorer/       # File tree with drag-and-drop
│   │   ├── Container/           # Dev container management panel and logs
│   │   ├── Git/                # Source control panel, diff viewer
│   │   ├── Outline/            # LSP document symbol outline
│   │   ├── OutputPanel/        # Script output with MIME rendering
│   │   ├── PackageManager/     # Julia package management UI
│   │   ├── PlotPane/           # Plot output gallery
│   │   ├── Plugin/             # Plugin management panel
│   │   ├── QuickOpen/          # Fuzzy file finder (Cmd+P)
│   │   ├── SearchPanel/        # Global file search (Cmd+Shift+F)
│   │   ├── Settings/           # Preferences panel
│   │   ├── StatusBar/          # Bottom status indicators
│   │   ├── Terminal/           # Multi-terminal with xterm.js
│   │   ├── TestRunner/         # Test execution with result parsing
│   │   ├── Toolbar/            # Run, debug, Revise, Pluto buttons
│   │   ├── Variables/          # Variable explorer with DataFrame viewer
│   │   └── Welcome/            # Welcome screen with recent projects
│   ├── lsp/                    # LSP client and Monaco providers
│   ├── services/               # Keybinding service, plugin host, builtin contributions
│   ├── stores/                 # Zustand state management
│   ├── themes/                 # Theme definitions (dark + light)
│   ├── types/                  # TypeScript interfaces
│   └── App.tsx                 # Root layout component
│
├── src-tauri/                  # Rust backend (Tauri 2)
│   └── src/
│       ├── main.rs             # Entry point
│       ├── lib.rs              # Command registry and plugin setup
│       ├── julia.rs            # Julia discovery, execution, Pkg commands
│       ├── lsp.rs              # LanguageServer.jl JSON-RPC bridge
│       ├── pty.rs              # PTY terminal management
│       ├── debugger.rs         # Debugger.jl integration
│       ├── fs.rs               # File system operations and dialogs
│       ├── git.rs              # Git operations via libgit2
│       ├── git_auth.rs         # PAT token storage via OS keychain (keyring)
│       ├── git_provider.rs     # Git provider trait and commands for PRs/issues/CI
│       ├── git_github.rs       # GitHub REST API provider implementation
│       ├── git_gitlab.rs       # GitLab REST API provider implementation
│       ├── git_gitea.rs        # Gitea REST API provider implementation
│       ├── container.rs        # Docker/Podman container and devcontainer management
│       ├── plugins.rs          # Plugin discovery and manifest loading
│       ├── search.rs           # Workspace-wide file search
│       ├── watcher.rs          # File change detection (notify crate)
│       ├── settings.rs         # User settings persistence
│       └── pluto.rs            # Pluto.jl notebook server
│
├── package.json                # Frontend dependencies (React, Monaco, xterm)
├── vite.config.ts              # Vite build configuration
├── tsconfig.json               # TypeScript configuration
└── src-tauri/Cargo.toml        # Rust dependencies (tauri, git2, tokio, etc.)
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop framework | Tauri 2 (Rust) |
| Frontend | React 19, TypeScript, Vite |
| Code editor | Monaco Editor |
| Terminal | xterm.js with PTY |
| State management | Zustand with Immer middleware |
| Icons | Lucide React |
| Git operations | git2 (libgit2 bindings) |
| File watching | notify crate |
| File search | walkdir + regex crates |
| LSP | LanguageServer.jl via JSON-RPC over stdio |
| Git provider API | reqwest (HTTP client for GitHub/GitLab/Gitea) |
| Token storage | keyring crate (OS keychain) |
| Container runtime | Docker / Podman CLI (auto-detected) |

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl+Shift+P` | Command Palette |
| `Cmd/Ctrl+P` | Quick Open (file finder) |
| `Cmd/Ctrl+F` | Find in file |
| `Cmd/Ctrl+H` | Find and replace |
| `Cmd/Ctrl+Shift+F` | Search across files |
| `Cmd/Ctrl+S` | Save file |
| `` Ctrl+` `` | Toggle terminal |
| `Cmd/Ctrl+G` | Go to Line |
| `Ctrl/Cmd+Enter` | Run code cell |
| `Cmd/Ctrl+,` | Open settings |

---

## Configuration

Settings are stored in `~/.config/julide/settings.json` (Linux), `~/Library/Application Support/julide/settings.json` (macOS), or `%APPDATA%/julide/settings.json` (Windows).

Available settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `fontSize` | `14` | Editor font size |
| `fontFamily` | `JetBrains Mono, ...` | Editor font family |
| `tabSize` | `4` | Indentation width |
| `minimapEnabled` | `true` | Show minimap |
| `wordWrap` | `off` | Word wrap mode |
| `autoSave` | `true` | Auto-save on change |
| `theme` | `julide-dark` | Color theme (`julide-dark` or `julide-light`) |
| `terminalFontSize` | `13` | Terminal font size |
| `containerRuntime` | `auto` | Container runtime (`auto`, `docker`, or `podman`) |
| `containerRemoteHost` | `""` | Remote Docker/Podman host URL |
| `containerAutoDetect` | `true` | Auto-detect devcontainer.json on workspace open |
| `displayForwarding` | `true` | Forward X11/Wayland display into containers |
| `gpuPassthrough` | `false` | Pass GPU devices into containers |
| `selinuxLabel` | `true` | Apply SELinux labels to bind mounts |
| `persistJuliaPackages` | `true` | Persist Julia packages across container rebuilds |
| `plutoPort` | `3000` | Port for the Pluto.jl notebook server |
| `juliaPath` | `""` | Custom Julia binary path (overrides auto-detection) |
| `startMaximized` | `true` | Start the window maximized |

---

## Julia Path Detection

julIDE automatically finds Julia using these strategies (in order):

1. `juliaPath` setting (if set via Settings or the command palette "Set Julia Executable Path")
2. `$JULIA_PATH` environment variable
3. Login shell `which julia` lookup
4. `~/.juliaup/bin/julia` (juliaup default)
5. Common paths: `/opt/homebrew/bin/julia`, `/usr/local/bin/julia`, `/usr/bin/julia`
6. macOS `/Applications/Julia*.app` bundles

If Julia is not found, use the command palette (`Cmd/Ctrl+Shift+P` → "Set Julia Executable Path") to pick a custom binary, or set the `JULIA_PATH` environment variable.

---

## License

[MIT](LICENSE) -- Copyright 2026 Ofek Bickel
