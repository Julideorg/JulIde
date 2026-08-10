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

- Powered by **[Fatou](https://github.com/jolars/fatou)** — a Julia language server, formatter,
  and linter written in Rust, **built into julIDE** and used by default
- **Autocompletion**, **hover documentation**, **go-to-definition**, **find references**
- **Signature help** with parameter info
- **Real-time diagnostics** (errors and warnings) shown inline and in the Problems panel
- **Error lens** — inline diagnostic messages displayed at the end of each line
- **Semantic tokens** — rich semantic highlighting beyond syntax-level tokenization
- **Workspace and document symbol search**
- **Formatting** — format document, format selection, and optional format-on-save
- **Workspace linting** — check every `.jl` file in the project, not just the open ones
- Swappable backends — [LanguageServer.jl](https://github.com/julia-vscode/LanguageServer.jl)
  and [JETLS.jl](https://github.com/aviatesk/JETLS.jl) remain selectable in Settings

#### Language server backends

Fatou is **vendored as a Rust library and runs inside julIDE's own process**, over an
in-memory channel rather than a pipe. There is nothing to install, no subprocess to
spawn, no `PATH` lookup, and no first-run precompilation — which also removes the class
of connection failures that made an external server flaky, particularly on Windows.

The trade-off is real and worth knowing: Fatou **never runs Julia**. It analyses source
text the way `rust-analyzer` analyses Rust, so it cannot infer types and does not know
the symbols, methods, or docstrings of your installed dependencies. If you work in a
package-heavy project and want completion for third-party symbols, switch to
LanguageServer.jl under **Settings → Julia → Language Server**.

|                       | **Fatou** (default) | **LanguageServer.jl**     | **JETLS.jl**           |
| --------------------- | ------------------- | ------------------------- | ---------------------- |
| Implementation        | Rust, built in      | Julia package             | Julia package          |
| Needs a Julia install | No                  | Yes                       | Yes (1.12+)            |
| Startup cost          | None                | Precompile + index (mins) | Precompilation         |
| Type-aware analysis   | No                  | Best-effort               | Yes — its core feature |
| Dependency symbols    | No                  | Yes                       | Yes                    |
| Formatter             | Built in            | JuliaFormatter.jl / Runic | Runic / JuliaFormatter |
| Linter                | Built in            | Built in                  | Built in               |
| Inlay hints           | No                  | Yes                       | Yes                    |
| Maturity              | Young               | Mature, de-facto default  | Experimental           |

Formatting is configurable under **Settings → Julia** (`fatouLineWidth`,
`fatouIndentWidth`). A [`fatou.toml`](https://fatou.dev/reference/configuration.html) in
the project takes precedence over those settings — that is Fatou's documented behaviour,
so per-project config wins over the IDE's defaults.

> Existing installs are migrated to Fatou once, on first launch after upgrading. If you
> pick a backend yourself afterwards, that choice is kept.

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

On **Windows**, use Docker Desktop with the WSL2 backend, or Podman Desktop. Open the
project from a Windows drive rather than through a `\\wsl$\...` path — a UNC path cannot
be bind-mounted into a container, and julIDE stops with that explanation rather than
handing the runtime a source it cannot resolve. If the Container panel says the runtime is
installed but not responding, Docker Desktop is not running; it does not start with the
session by default.

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

| Permission                         | Grants                                          |
| ---------------------------------- | ----------------------------------------------- |
| `workspace:read`                   | Read files and list directories                 |
| `workspace:write`                  | Create, edit, rename, delete files              |
| `julia:run`                        | Execute Julia code                              |
| `julia:packages`                   | `Pkg.add` / `Pkg.rm`                            |
| `julia:configure`                  | Change the Julia interpreter, scaffold projects |
| `terminal`                         | Open PTY sessions and write to them             |
| `debugger`                         | Breakpoints, stepping, variable inspection      |
| `lsp`                              | Send language server requests, lint the project |
| `git:read`                         | Status, diff, log, branches, blame, PRs, issues |
| `git:write`                        | Stage, commit, branch, merge, stash, push, pull |
| `git:credentials`                  | Read and modify stored access tokens            |
| `containers`                       | Docker/Podman and dev container control         |
| `settings:read` / `settings:write` | Read / modify julIDE preferences                |
| `pluto`                            | Start and stop the Pluto notebook server        |
| `dialogs`                          | Native file and folder pickers                  |

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
Pkg.add("Revise")          # Hot-reload
Pkg.add("Debugger")        # Debugger integration
Pkg.add("Pluto")           # Reactive notebooks
Pkg.add("LanguageServer")  # Only if you switch off the built-in Fatou backend
```

Language support needs nothing installed — Fatou ships with julIDE.

---

## Installation

### macOS — Homebrew

```bash
brew tap Julideorg/tap
brew install --cask julide
```

The [tap](https://github.com/Julideorg/homebrew-tap) clears the Gatekeeper quarantine
flag for you, so there is no extra step after installing.

### Linux — Flatpak

```bash
flatpak install https://julide-rgstry.org/julide.flatpakref
```

That single URL carries the repository, its signing key, and a pointer to Flathub for the
GNOME runtime, so it works even on a machine with no remotes configured. To add the
remote explicitly instead:

```bash
flatpak remote-add --if-not-exists julide https://julide-rgstry.org/julide.flatpakrepo
flatpak install julide io.github.Julideorg.JulIde
```

Updates arrive through `flatpak update`, GNOME Software, or KDE Discover. The remote is
self-hosted rather than on Flathub, and is built by
[julide-flatpak](https://github.com/Julideorg/julide-flatpak).

Three differences from the other Linux builds:

- **Julia is bundled**, so there is nothing else to install. Packages still go to your
  normal `~/.julia` depot, shared with any other Julia on the machine.
- **Dev containers are unavailable.** Docker and Podman run on the host, and reaching
  them from inside the sandbox would need a permission equivalent to leaving the sandbox.
  Use the `.deb`, `.rpm` or AppImage if you need them.
- **x86_64 only** for now.

Settings do not carry over from a native install, because Flatpak gives the app its own
config directory. To bring them across:

```bash
mkdir -p ~/.var/app/io.github.Julideorg.JulIde/config
cp -r ~/.config/julide ~/.config/com.ofek.julide ~/.var/app/io.github.Julideorg.JulIde/config/
```

### Any platform — direct download

Download the latest build from the
[releases page](https://github.com/Julideorg/JulIde/releases).

| Platform  | Download             | Notes                                                                                                |
| --------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| **Linux** | `.AppImage`          | Recommended download — supports in-app updates. `chmod +x` then run. (Or install the Flatpak above.) |
| Linux     | `.deb` / `.rpm`      | Installs system-wide and registers `.jl` files. Updates via your package manager.                    |
| Windows   | `-setup.exe`, `.msi` | Recommended. Also the right download if you use WSL2 — see below.                                    |
| Windows   | `-portable.exe`      | Single file, no installation — run it from anywhere, including a USB stick. See the caveats below.   |
| macOS     | `.dmg`               | Apple Silicon and Intel builds are published separately.                                             |

You also need **Julia 1.6+** ([download](https://julialang.org/downloads/)). Apart from
the Linux Flatpak, which bundles it, julIDE does not. If Julia is not found on first
launch, julIDE will offer to help you install or locate it.

### The Windows portable build

`julide_<version>_x64-portable.exe` is the same application as the installer, as a
single file that runs where you put it. Nothing is written to Program Files and nothing
is registered, so it needs no administrator rights — useful on a locked-down machine, or
to try julIDE without committing to it. Three things to know before you pick it over the
installer:

- **It needs the WebView2 runtime already on the machine.** Windows 11 and current
  Windows 10 ship it. The installers can fetch it if it is missing; a single file
  cannot. If the window never appears, that is the reason —
  [install the Evergreen runtime](https://developer.microsoft.com/microsoft-edge/webview2/)
  and run it again.
- **It runs without installing; it does not run without a trace.** Settings, plugins and
  their permission grants still live under `%APPDATA%` and `%USERPROFILE%`, the same as
  for an installed copy. Deleting the `.exe` leaves those behind, and moving it to
  another machine does not carry them along.
- **It does not update itself.** See [Updates](#updates).

### If you use WSL2

Install the **Windows** build, not the Linux AppImage inside your WSL distro, and reach
your Linux toolchain through [Dev Containers](#dev-container-support) instead.

The native build renders on the GPU through the system WebView, gets real Windows window
management and file dialogs, and can update itself in place. An AppImage running inside
WSL reaches your screen through WSLg's display bridge and, if the project lives on the
Windows side, reads every file over the `\\wsl$` 9P bridge — which is where the "why is
the editor slow" reports come from. Nothing about it is broken; it is just paying for a
translation layer twice.

A dev container gives you the Linux side properly: the container is a real Linux
environment with its own Julia, packages and system libraries, and julIDE runs its
terminal, REPL and file execution inside it.

One constraint worth knowing before you start: open the project from a Windows drive
(`C:\Users\you\project`), not through a `\\wsl$\...` path. A UNC path is not something
Docker or Podman can bind-mount, and julIDE now says so up front rather than letting the
container fail several steps later.

### Unsigned builds

julIDE is not yet code-signed, so your OS will warn you on first launch:

- **Windows** — SmartScreen shows "Windows protected your PC". Click **More info** →
  **Run anyway**.
- **macOS** — Gatekeeper reports the app "cannot be opened". Either right-click the
  app and choose **Open**, or run:

  ```bash
  xattr -dr com.apple.quarantine /Applications/julide.app
  ```

  This applies to the `.dmg` download only — `brew install --cask julide` already does
  it for you.

- **Linux** — no warning; AppImages just need the executable bit.

This is expected for an unsigned application and is documented in
[SECURITY.md](SECURITY.md). Signing is planned.

---

## Getting Started

> This section is for building julIDE from source. If you just want to use it, see
> [Installation](#installation) above.

### Clone and install

```bash
git clone https://github.com/Julideorg/JulIde.git
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

The output is placed in `src-tauri/target/release/bundle/`. `bundle.targets` is set to
`"all"`, so each platform produces everything it can: `.deb`, `.rpm`, and `.AppImage` on
Linux; `.msi` and `.exe` on Windows; `.app` and `.dmg` on macOS. A build only produces
artifacts for the platform it runs on — the release workflow builds all four targets.

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
│       ├── lsp.rs              # LSP bridge: in-process Fatou or a stdio child
│       ├── fatou_tools.rs      # Workspace-wide linting via Fatou's Rust API
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

| Layer             | Technology                                             |
| ----------------- | ------------------------------------------------------ |
| Desktop framework | Tauri 2 (Rust)                                         |
| Frontend          | React 19, TypeScript, Vite                             |
| Code editor       | Monaco Editor                                          |
| Terminal          | xterm.js with PTY                                      |
| State management  | Zustand with Immer middleware                          |
| Icons             | Lucide React                                           |
| Git operations    | git2 (libgit2 bindings)                                |
| File watching     | notify crate                                           |
| File search       | walkdir + regex crates                                 |
| LSP               | Fatou, linked in and driven over an in-process channel |
| Git provider API  | reqwest (HTTP client for GitHub/GitLab/Gitea)          |
| Token storage     | keyring crate (OS keychain)                            |
| Container runtime | Docker / Podman CLI (auto-detected)                    |

---

## Keyboard Shortcuts

| Shortcut           | Action                   |
| ------------------ | ------------------------ |
| `Cmd/Ctrl+Shift+P` | Command Palette          |
| `Cmd/Ctrl+P`       | Quick Open (file finder) |
| `Cmd/Ctrl+F`       | Find in file             |
| `Cmd/Ctrl+H`       | Find and replace         |
| `Cmd/Ctrl+Shift+F` | Search across files      |
| `Cmd/Ctrl+S`       | Save file                |
| `` Ctrl+` ``       | Toggle terminal          |
| `Cmd/Ctrl+G`       | Go to Line               |
| `Ctrl/Cmd+Enter`   | Run code cell            |
| `Cmd/Ctrl+,`       | Open settings            |

---

## Configuration

Settings are stored in `~/.config/julide/settings.json` (Linux), `~/Library/Application Support/julide/settings.json` (macOS), or `%APPDATA%/julide/settings.json` (Windows).

Available settings:

| Setting                | Default               | Description                                          |
| ---------------------- | --------------------- | ---------------------------------------------------- |
| `fontSize`             | `14`                  | Editor font size                                     |
| `fontFamily`           | `JetBrains Mono, ...` | Editor font family                                   |
| `tabSize`              | `4`                   | Indentation width                                    |
| `minimapEnabled`       | `true`                | Show minimap                                         |
| `wordWrap`             | `off`                 | Word wrap mode                                       |
| `autoSave`             | `true`                | Auto-save on change                                  |
| `theme`                | `julide-dark`         | Color theme (`julide-dark` or `julide-light`)        |
| `terminalFontSize`     | `13`                  | Terminal font size                                   |
| `containerRuntime`     | `auto`                | Container runtime (`auto`, `docker`, or `podman`)    |
| `containerRemoteHost`  | `""`                  | Remote Docker/Podman host URL                        |
| `containerAutoDetect`  | `true`                | Auto-detect devcontainer.json on workspace open      |
| `displayForwarding`    | `true`                | Forward X11/Wayland display into containers          |
| `gpuPassthrough`       | `false`               | Pass GPU devices into containers                     |
| `selinuxLabel`         | `true`                | Apply SELinux labels to bind mounts                  |
| `persistJuliaPackages` | `true`                | Persist Julia packages across container rebuilds     |
| `plutoPort`            | `3000`                | Port for the Pluto.jl notebook server                |
| `juliaPath`            | `""`                  | Custom Julia binary path (overrides auto-detection)  |
| `lspBackend`           | `fatou`               | Language server (`fatou`, `languageserver`, `jetls`) |
| `fatouLineWidth`       | `92`                  | Target line length Fatou formats to                  |
| `fatouIndentWidth`     | `4`                   | Spaces per indent level Fatou formats with           |
| `formatOnSave`         | `false`               | Format through the language server on explicit save  |
| `startMaximized`       | `true`                | Start the window maximized                           |

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

## Updates

julIDE checks for new releases on startup and shows a banner when one is available.

**What it can install depends on how you installed it.** `tauri-plugin-updater` can only
replace the running binary when that binary is a single self-contained file:

| Install                 | In-app update                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **AppImage** (Linux)    | Yes — one click, then restart. **Recommended download on Linux.**                                                                           |
| `.deb` / `.rpm`         | No — these are owned by your package manager. julIDE still tells you a new version exists and links to the download page.                   |
| Flatpak (Linux)         | No — update with `flatpak update`, GNOME Software or KDE Discover.                                                                          |
| Windows `.msi` / setup  | Yes                                                                                                                                         |
| Windows portable `.exe` | No — an update on Windows is applied by running an installer, which would install julIDE beside your portable copy instead of replacing it. |
| macOS `.app` / `.dmg`   | Yes                                                                                                                                         |

Run **Check for Updates** from the command palette (`Cmd/Ctrl+Shift+P`) to check manually.

---

## License

[MIT](LICENSE) -- Copyright 2026 Ofek Bickel
