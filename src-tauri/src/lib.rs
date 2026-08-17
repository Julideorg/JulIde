mod container;
mod debugger;
mod fatou_tools;
mod fs;
mod git;
mod git_auth;
mod git_gitea;
mod git_github;
mod git_gitlab;
mod git_provider;
mod http;
mod images;
mod julia;
mod lsp;
mod marketplace;
mod menu;
mod notebook_session;
mod plugin_protocol;
mod plugins;
mod pluto;
mod portable;
mod pty;
mod search;
mod settings;
mod sync;
mod trust;
mod updater;
mod watcher;
mod window;

use julia::new_julia_state;
use tauri::Manager;

/// WebKitGTK renders into a DMA-BUF and hands the buffer to the UI process. On a
/// long tail of Linux setups that buffer can never be allocated — NVIDIA's
/// proprietary driver under Wayland, WSL, VMs and containers without a working
/// DRI render node — and the failure mode is the worst kind: no window at all,
/// with nothing but `libEGL warning: …` on stderr to go on. See issue #36.
///
/// Turning the renderer off makes WebKit fall back to shared-memory buffers.
/// That path costs some compositing performance on machines where DMA-BUF would
/// have worked, which is the deliberate trade: an IDE that starts slightly
/// slower everywhere beats one that does not start at all somewhere.
///
/// Doing this here rather than in packaging is what makes it uniform — the .deb,
/// the .rpm, the AppImage, distro and source builds, and binaries swapped in by
/// the updater all enter through `run`, and none of them need a wrapper script.
///
/// The variable has to be in place before the webview spawns WebKit's child
/// processes, hence the call at the top of `run` while we are still
/// single-threaded and nothing has touched the environment yet.
#[cfg(target_os = "linux")]
fn disable_webkit_dmabuf_renderer() {
    const VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

    match std::env::var_os(VAR) {
        // Anyone whose GPU path works can opt back in with
        // `WEBKIT_DISABLE_DMABUF_RENDERER=0 julide`. Unset the variable instead
        // of forwarding the "0", because WebKitGTK has historically tested some
        // of these switches for presence alone and would keep the renderer off.
        Some(value) if matches!(value.to_str(), Some("0") | Some("")) => std::env::remove_var(VAR),
        // Any other explicit value is the user's decision; leave it untouched.
        Some(_) => {}
        None => std::env::set_var(VAR, "1"),
    }
}

/// The window-state plugin, pointed at the portable data directory when there is one.
///
/// The plugin resolves its file as `app_config_dir().join(filename)` and exposes no
/// way to change the directory — only the name. Handing it an absolute path as that
/// "name" is what redirects it, because `join` discards its left-hand side when the
/// right-hand side is absolute. See `portable::window_state_file`, which both this
/// and `settings::has_saved_window_state` go through so the two cannot drift.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn window_state_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let builder = tauri_plugin_window_state::Builder::default();
    if portable::is_portable() {
        builder.with_filename(portable::window_state_file().to_string_lossy())
    } else {
        builder
    }
    .build()
}

/// Create the windows Tauri was told not to create, with the webview's profile
/// pointed inside the portable data directory.
///
/// Only reachable in portable mode, and it exists for one reason: the WebView2
/// user-data folder cannot be moved any other way. `tauri.conf.json` accepts only a
/// relative path, resolved under `%LOCALAPPDATA%`; the builder method that takes an
/// absolute one has to run *before* the window is built, and Tauri builds windows
/// declared in the config before `setup` is called. So portable mode turns
/// `create` off for those windows in the context and builds them here instead.
///
/// Left alone, WebView2 keeps a full profile — cache, cookies, local storage,
/// IndexedDB — under `%LOCALAPPDATA%\com.ofek.julide` regardless of where the
/// executable was run from. It is the largest trace a "portable" build was leaving.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn create_portable_windows<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    // `None` here is exactly the case where `create` was left alone above — both
    // ask the same `portable::data_root()`, which is resolved once — so this
    // cannot end with a window nobody created.
    let Some(data_dir) = portable::webview_data_dir() else {
        return Ok(());
    };

    for config in app.config().app.windows.clone() {
        tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
            .data_directory(data_dir.clone())
            .build()?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    disable_webkit_dmabuf_renderer();

    #[cfg_attr(mobile, allow(unused_mut))]
    let mut context = tauri::generate_context!();

    // Portable mode builds the main window itself; see `create_portable_windows`.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    if portable::is_portable() {
        for window in context.config_mut().app.windows.iter_mut() {
            window.create = false;
        }
    }

    let builder = tauri::Builder::default()
        // Sandboxed plugin frames. Registered before the webview exists, because a
        // custom scheme cannot be added afterwards. See src/plugin_protocol.rs.
        .register_uri_scheme_protocol("julide-plugin", |ctx, request| {
            let app_origin = if tauri::is_dev() {
                "http://localhost:1420"
            } else if cfg!(any(windows, target_os = "android")) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            };
            let _ = ctx;
            crate::plugin_protocol::handle_request(&request, app_origin)
        })
        .plugin(tauri_plugin_opener::init())
        // The shell and fs plugins are deliberately not registered: the frontend
        // never uses them (all such work goes through the commands below), and
        // registering them only widens what a compromised webview could reach.
        // dialog is registered because fs.rs drives the native pickers from Rust.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(new_julia_state());

    // Restores the window's size and position from the previous run.
    //
    // Registered on the builder rather than from inside `setup`, where it used to
    // live. Tauri dispatches the hook that *restores* geometry as each window is
    // built, and windows declared in tauri.conf.json are built before `setup`
    // runs — so a plugin registered inside `setup` joined the store too late to
    // ever see the main window. Only the saving half worked, and what it saved was
    // an empty `{}`, which `has_saved_window_state` then read as "the user has
    // picked a size" and used to disable `start_maximized` from the second launch
    // on. Both halves work from here.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(window_state_plugin());

    builder
        // Builder::setup takes a single closure — a second call replaces the first,
        // so everything that runs at startup belongs in here.
        .setup(|app| {
            // Desktop only: on mobile the platform store handles updates.
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                // Only used to restart after an update has been staged.
                app.handle().plugin(tauri_plugin_process::init())?;

                // No-op unless this is a portable copy. Runs before the menu and the
                // maximize decision below, both of which want a window to exist.
                create_portable_windows(app)?;
            }

            // Native application menu. On macOS this is also what provides the
            // standard Edit menu, and therefore working system clipboard shortcuts.
            let settings = crate::settings::settings_load();
            let menu = crate::menu::build(app.handle(), settings.ascii_only)?;
            app.set_menu(menu)?;

            // Only force-maximize on a first run. Once the window-state plugin has
            // a saved geometry, honouring `start_maximized` unconditionally would
            // override whatever size the user actually left the window at.
            if settings.start_maximized && !crate::settings::has_saved_window_state() {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.maximize();
                }
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            crate::menu::on_menu_event(app, event.id().as_ref());
        })
        // Ask the frontend about unsaved work before the window goes; see window.rs.
        .on_window_event(crate::window::on_window_event)
        .invoke_handler(tauri::generate_handler![
            // File system
            fs::fs_get_tree,
            fs::fs_read_file,
            fs::fs_write_file,
            fs::fs_write_file_atomic,
            fs::fs_stat,
            fs::fs_create_file,
            fs::fs_create_dir,
            fs::fs_delete_entry,
            fs::fs_rename,
            fs::fs_exists,
            fs::dialog_open_file,
            fs::dialog_pick_executable,
            fs::dialog_open_folder,
            fs::dialog_save_file,
            // Julia
            julia::julia_get_version,
            julia::julia_list_environments,
            julia::julia_run,
            julia::julia_precompile,
            julia::julia_clean,
            julia::julia_kill,
            julia::julia_eval,
            julia::julia_set_path,
            julia::julia_pkg_add,
            julia::julia_pkg_rm,
            julia::julia_create_project,
            julia::julia_create_project_bestie,
            // PTY / Terminal
            pty::pty_create,
            pty::pty_create_shell,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            // Debugger
            debugger::debug_start,
            debugger::debug_continue,
            debugger::debug_step_over,
            debugger::debug_step_into,
            debugger::debug_step_out,
            debugger::debug_stop,
            debugger::debug_set_breakpoint,
            debugger::debug_remove_breakpoint,
            debugger::debug_get_breakpoints,
            debugger::debug_get_variables,
            // LSP
            lsp::lsp_start,
            lsp::lsp_stop,
            lsp::lsp_send_request,
            lsp::lsp_send_notification,
            lsp::lsp_send_response,
            // Fatou tools (workspace-wide, beyond what the LSP session covers)
            fatou_tools::fatou_lint_workspace,
            // Pluto
            pluto::pluto_open,
            pluto::pluto_stop,
            // Search
            search::fs_search_files,
            search::fs_replace_in_files,
            // File watcher
            watcher::watcher_start,
            watcher::watcher_stop,
            // Settings
            settings::settings_load,
            settings::settings_save,
            settings::settings_add_recent_workspace,
            settings::settings_remove_recent_workspace,
            // Updater
            updater::updater_install_capability,
            // Window lifecycle
            window::app_confirm_close,
            // Git
            git::git_is_repo,
            git::git_branch_current,
            git::git_branches,
            git::git_status,
            git::git_diff,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_log,
            git::git_checkout_branch,
            // Git (new commands)
            git::git_remotes,
            git::git_remote_url,
            git::git_branch_create,
            git::git_branch_delete,
            git::git_merge,
            git::git_stash_save,
            git::git_stash_list,
            git::git_stash_pop,
            git::git_fetch,
            git::git_push,
            git::git_pull,
            git::git_ahead_behind,
            git::git_show_file_at_head,
            git::git_blame_file,
            // Git Auth
            git_auth::git_auth_save_token,
            git_auth::git_auth_get_token,
            git_auth::git_auth_remove_token,
            git_auth::git_auth_list_accounts,
            // Git Provider
            git_provider::git_provider_detect,
            git_provider::git_provider_repo_info,
            git_provider::git_provider_list_prs,
            git_provider::git_provider_create_pr,
            git_provider::git_provider_merge_pr,
            git_provider::git_provider_list_issues,
            git_provider::git_provider_create_issue,
            git_provider::git_provider_ci_status,
            // Plugins
            plugins::plugin_get_dir,
            plugins::plugin_scan,
            plugins::plugin_grants_load,
            plugins::plugin_grants_save,
            // Container
            container::container_support_available,
            container::container_detect_runtime,
            container::container_set_runtime,
            container::container_list,
            container::container_list_images,
            container::container_inspect,
            container::container_start,
            container::container_stop,
            container::container_restart,
            container::container_remove,
            container::container_logs,
            container::container_pull_image,
            container::container_exec,
            container::devcontainer_detect,
            container::devcontainer_load_config,
            container::devcontainer_trust_status,
            container::devcontainer_trust_grant,
            container::devcontainer_trust_revoke,
            container::devcontainer_up,
            container::devcontainer_stop,
            container::devcontainer_rebuild,
            container::devcontainer_down,
            container::container_pty_create,
            container::container_julia_run,
            // Marketplace — deliberately absent from COMMAND_PERMISSIONS in
            // src/services/pluginPermissions.ts. A plugin that can install plugins is
            // privilege escalation with no legitimate use.
            marketplace::marketplace_fetch_index,
            marketplace::marketplace_fetch_revocations,
            marketplace::marketplace_install,
            marketplace::marketplace_uninstall,
            marketplace::marketplace_check_updates,
            // Images — deliberately absent from COMMAND_PERMISSIONS too. The command is
            // gated on a user setting, and a plugin that could call it would be reading
            // workspace files and making outbound requests under the user's answer to a
            // question the user was never asked about that plugin.
            images::image_load,
            // Notebook kernels — deliberately absent from COMMAND_PERMISSIONS, like the
            // marketplace commands above. `julia_eval` is already arbitrary execution so
            // the capability class is not new, but the *persistence* is: a plugin
            // reaching these could read every variable the user's cells defined and
            // rewrite Main underneath them.
            notebook_session::notebook_session_start,
            notebook_session::notebook_session_exec,
            notebook_session::notebook_session_interrupt,
            notebook_session::notebook_session_restart,
            notebook_session::notebook_session_stop,
            notebook_session::notebook_session_status,
        ])
        .build(context)
        .expect("error while building tauri application")
        // `.run(context)` gives no exit hook, and `kill_on_drop` does not help because
        // nothing drops the session registry at exit() — so quitting used to leave one
        // orphaned `julia` per notebook kernel.
        .run(|_app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                notebook_session::kill_all_on_exit();
                // Runs after the plugins have handled this event — Tauri dispatches
                // to them first — so the window state is already saved and the empty
                // directory the window-state plugin makes on the way past is there
                // to be swept. No-op outside portable mode.
                portable::clean_profile_leftovers();
            }
        });
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    const VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

    // One test rather than three: the environment is process-global, so separate
    // cases would race against each other under the threaded test harness.
    #[test]
    fn dmabuf_renderer_default_and_overrides() {
        // Unset: the workaround applies, which is the whole point.
        std::env::remove_var(VAR);
        disable_webkit_dmabuf_renderer();
        assert_eq!(std::env::var(VAR).as_deref(), Ok("1"));

        // Already disabled by the caller: left exactly as it was found.
        std::env::set_var(VAR, "2");
        disable_webkit_dmabuf_renderer();
        assert_eq!(std::env::var(VAR).as_deref(), Ok("2"));

        // Opting back in has to clear the variable, not set it to "0", or a
        // presence-only check inside WebKitGTK would still see it as disabled.
        for opt_in in ["0", ""] {
            std::env::set_var(VAR, opt_in);
            disable_webkit_dmabuf_renderer();
            assert!(std::env::var_os(VAR).is_none(), "{opt_in:?} should unset");
        }

        std::env::remove_var(VAR);
    }
}
