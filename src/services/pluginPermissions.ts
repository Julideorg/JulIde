/**
 * Permission model for third-party plugins.
 *
 * Plugins are arbitrary JavaScript loaded from `~/.julide/plugins/` and executed in
 * the app's webview. Before this existed they received the raw `invoke` bridge,
 * which meant every one of julIDE's Tauri commands — arbitrary shell execution via
 * `container_exec`, arbitrary writes via `fs_write_file`, plaintext access tokens via
 * `git_auth_get_token` — with no declaration, no prompt, and no way to audit or revoke.
 *
 * A plugin now declares what it needs in `plugin.json`, the user approves it once, and
 * every `invoke` is checked against that grant. The mapping below is deliberately
 * exhaustive and **fails closed**: a command that is not listed cannot be called at
 * all, so adding a new Tauri command never silently widens what plugins can reach.
 */

export type PluginPermission =
  | "workspace:read"
  | "workspace:write"
  | "julia:run"
  | "julia:packages"
  | "julia:configure"
  | "terminal"
  | "debugger"
  | "lsp"
  | "git:read"
  | "git:write"
  | "git:credentials"
  | "containers"
  | "settings:read"
  | "settings:write"
  | "pluto"
  | "dialogs";

export interface PermissionInfo {
  /** Shown in the consent dialog. */
  title: string;
  /** Plain-language description of what granting this actually allows. */
  description: string;
  /**
   * High-risk permissions can lead to arbitrary code execution, credential
   * disclosure, or irreversible data loss. The consent dialog calls these out.
   */
  risk: "normal" | "high";
}

export const PERMISSION_CATALOG: Record<PluginPermission, PermissionInfo> = {
  "workspace:read": {
    title: "Read workspace files",
    description: "Read any file and list any directory on this computer.",
    risk: "normal",
  },
  "workspace:write": {
    title: "Modify workspace files",
    description: "Create, edit, rename, and delete files anywhere on this computer.",
    risk: "high",
  },
  "julia:run": {
    title: "Run Julia code",
    description: "Execute Julia scripts and expressions, which can do anything you can do.",
    risk: "high",
  },
  "julia:packages": {
    title: "Manage Julia packages",
    description: "Install and remove Julia packages in your environments.",
    risk: "normal",
  },
  "julia:configure": {
    title: "Change the Julia interpreter",
    description:
      "Choose which binary julIDE runs as Julia, and scaffold new projects. A plugin with this permission can point julIDE at any executable.",
    risk: "high",
  },
  terminal: {
    title: "Use the terminal",
    description:
      "Open terminal sessions and type into them — equivalent to running shell commands.",
    risk: "high",
  },
  debugger: {
    title: "Control the debugger",
    description: "Set breakpoints, step through code, and read local variables.",
    risk: "normal",
  },
  lsp: {
    title: "Talk to the language server",
    description: "Send requests to LanguageServer.jl and read its responses.",
    risk: "normal",
  },
  "git:read": {
    title: "Read git history",
    description: "Read status, diffs, branches, log, and blame for the open repository.",
    risk: "normal",
  },
  "git:write": {
    title: "Modify the repository",
    description: "Stage, commit, branch, merge, stash, push, and pull.",
    risk: "high",
  },
  "git:credentials": {
    title: "Access your git access tokens",
    description:
      "Read and modify the personal access tokens stored in your OS keychain. Only grant this to a plugin you fully trust.",
    risk: "high",
  },
  containers: {
    title: "Manage containers",
    description:
      "Start, stop, and run commands inside Docker/Podman containers, and start dev containers. This allows arbitrary command execution.",
    risk: "high",
  },
  "settings:read": {
    title: "Read julIDE settings",
    description: "Read your julIDE preferences.",
    risk: "normal",
  },
  "settings:write": {
    title: "Change julIDE settings",
    description: "Modify your julIDE preferences and recent-workspace list.",
    risk: "normal",
  },
  pluto: {
    title: "Control Pluto notebooks",
    description: "Start and stop the Pluto.jl notebook server.",
    risk: "normal",
  },
  dialogs: {
    title: "Show file dialogs",
    description: "Open native file and folder pickers.",
    risk: "normal",
  },
};

export const ALL_PERMISSIONS = Object.keys(PERMISSION_CATALOG) as PluginPermission[];

/**
 * Command → required permission.
 *
 * Anything absent from this map is denied outright. `plugin_*` commands are
 * deliberately omitted: a plugin has no business rescanning the plugin directory or
 * reading another plugin's source.
 */
export const COMMAND_PERMISSIONS: Record<string, PluginPermission> = {
  // ── Filesystem ────────────────────────────────────────────────────────
  fs_get_tree: "workspace:read",
  fs_read_file: "workspace:read",
  fs_exists: "workspace:read",
  fs_search_files: "workspace:read",
  fs_write_file: "workspace:write",
  fs_create_file: "workspace:write",
  fs_create_dir: "workspace:write",
  fs_delete_entry: "workspace:write",
  fs_rename: "workspace:write",
  fs_replace_in_files: "workspace:write",

  // ── Dialogs ───────────────────────────────────────────────────────────
  dialog_open_file: "dialogs",
  dialog_open_folder: "dialogs",
  dialog_save_file: "dialogs",
  // Picking an executable feeds julia_set_path, so it is gated with it.
  dialog_pick_executable: "julia:configure",

  // ── Julia ─────────────────────────────────────────────────────────────
  julia_get_version: "julia:run",
  julia_list_environments: "julia:run",
  julia_run: "julia:run",
  julia_eval: "julia:run",
  julia_kill: "julia:run",
  julia_precompile: "julia:run",
  julia_clean: "julia:run",
  julia_pkg_add: "julia:packages",
  julia_pkg_rm: "julia:packages",
  julia_set_path: "julia:configure",
  julia_create_project: "julia:configure",
  julia_create_project_bestie: "julia:configure",

  // ── Terminal ──────────────────────────────────────────────────────────
  pty_create: "terminal",
  pty_create_shell: "terminal",
  pty_write: "terminal",
  pty_resize: "terminal",
  pty_close: "terminal",

  // ── Debugger ──────────────────────────────────────────────────────────
  debug_start: "debugger",
  debug_continue: "debugger",
  debug_step_over: "debugger",
  debug_step_into: "debugger",
  debug_step_out: "debugger",
  debug_stop: "debugger",
  debug_set_breakpoint: "debugger",
  debug_remove_breakpoint: "debugger",
  debug_get_breakpoints: "debugger",
  debug_get_variables: "debugger",

  // ── LSP ───────────────────────────────────────────────────────────────
  lsp_start: "lsp",
  lsp_stop: "lsp",
  lsp_send_request: "lsp",
  lsp_send_notification: "lsp",
  lsp_send_response: "lsp",

  // ── Pluto ─────────────────────────────────────────────────────────────
  pluto_open: "pluto",
  pluto_stop: "pluto",

  // ── File watcher ──────────────────────────────────────────────────────
  watcher_start: "workspace:read",
  watcher_stop: "workspace:read",

  // ── Settings ──────────────────────────────────────────────────────────
  settings_load: "settings:read",
  settings_save: "settings:write",
  settings_add_recent_workspace: "settings:write",
  settings_remove_recent_workspace: "settings:write",

  // ── Git (read) ────────────────────────────────────────────────────────
  git_is_repo: "git:read",
  git_branch_current: "git:read",
  git_branches: "git:read",
  git_status: "git:read",
  git_diff: "git:read",
  git_log: "git:read",
  git_remotes: "git:read",
  git_remote_url: "git:read",
  git_ahead_behind: "git:read",
  git_show_file_at_head: "git:read",
  git_blame_file: "git:read",
  git_stash_list: "git:read",

  // ── Git (write) ───────────────────────────────────────────────────────
  git_stage: "git:write",
  git_unstage: "git:write",
  git_commit: "git:write",
  git_checkout_branch: "git:write",
  git_branch_create: "git:write",
  git_branch_delete: "git:write",
  git_merge: "git:write",
  git_stash_save: "git:write",
  git_stash_pop: "git:write",
  git_fetch: "git:write",
  git_push: "git:write",
  git_pull: "git:write",

  // ── Git credentials ───────────────────────────────────────────────────
  git_auth_save_token: "git:credentials",
  git_auth_get_token: "git:credentials",
  git_auth_remove_token: "git:credentials",
  git_auth_list_accounts: "git:credentials",

  // ── Git providers (network calls made with the stored token) ──────────
  git_provider_detect: "git:read",
  git_provider_repo_info: "git:read",
  git_provider_list_prs: "git:read",
  git_provider_list_issues: "git:read",
  git_provider_ci_status: "git:read",
  git_provider_create_pr: "git:write",
  git_provider_merge_pr: "git:write",
  git_provider_create_issue: "git:write",

  // ── Containers ────────────────────────────────────────────────────────
  container_detect_runtime: "containers",
  container_set_runtime: "containers",
  container_list: "containers",
  container_list_images: "containers",
  container_inspect: "containers",
  container_start: "containers",
  container_stop: "containers",
  container_restart: "containers",
  container_remove: "containers",
  container_logs: "containers",
  container_pull_image: "containers",
  container_exec: "containers",
  container_pty_create: "containers",
  container_julia_run: "containers",
  devcontainer_detect: "containers",
  devcontainer_load_config: "containers",
  devcontainer_up: "containers",
  devcontainer_stop: "containers",
  devcontainer_rebuild: "containers",
  devcontainer_down: "containers",
};

/** Keep only strings that name a real permission. */
export function parsePermissions(raw: readonly string[] | undefined): PluginPermission[] {
  if (!raw) return [];
  const known = new Set<string>(ALL_PERMISSIONS);
  return Array.from(new Set(raw.filter((p): p is PluginPermission => known.has(p))));
}

/** Permissions listed in a manifest that julIDE does not recognise. */
export function unknownPermissions(raw: readonly string[] | undefined): string[] {
  if (!raw) return [];
  const known = new Set<string>(ALL_PERMISSIONS);
  return raw.filter((p) => !known.has(p));
}

export class PluginPermissionError extends Error {
  constructor(
    readonly pluginId: string,
    readonly command: string,
    readonly required: PluginPermission | null,
  ) {
    super(
      required
        ? `Plugin "${pluginId}" tried to call "${command}" without the "${required}" permission. ` +
            `Add it to the plugin's plugin.json and re-approve the plugin in Settings → Plugins.`
        : `Plugin "${pluginId}" tried to call "${command}", which plugins may never call.`,
    );
    this.name = "PluginPermissionError";
  }
}

/**
 * Throw unless `granted` covers the given command.
 *
 * Fails closed on unmapped commands — see the module comment.
 */
export function assertCommandAllowed(
  pluginId: string,
  command: string,
  granted: readonly PluginPermission[],
): void {
  const required = COMMAND_PERMISSIONS[command];
  if (!required) throw new PluginPermissionError(pluginId, command, null);
  if (!granted.includes(required)) {
    throw new PluginPermissionError(pluginId, command, required);
  }
}
