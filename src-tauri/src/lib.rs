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
mod julia;
mod lsp;
mod menu;
mod plugins;
mod pluto;
mod pty;
mod search;
mod settings;
mod sync;
mod trust;
mod updater;
mod watcher;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    disable_webkit_dmabuf_renderer();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // The shell and fs plugins are deliberately not registered: the frontend
        // never uses them (all such work goes through the commands below), and
        // registering them only widens what a compromised webview could reach.
        // dialog is registered because fs.rs drives the native pickers from Rust.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(new_julia_state())
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

                // Restores the window's size and position from the previous run.
                // Registered here rather than at the top so it applies before the
                // maximize decision below.
                app.handle()
                    .plugin(tauri_plugin_window_state::Builder::default().build())?;
            }

            // Native application menu. On macOS this is also what provides the
            // standard Edit menu, and therefore working system clipboard shortcuts.
            let menu = crate::menu::build(app.handle())?;
            app.set_menu(menu)?;

            let settings = crate::settings::settings_load();
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
        .invoke_handler(tauri::generate_handler![
            // File system
            fs::fs_get_tree,
            fs::fs_read_file,
            fs::fs_write_file,
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
            plugins::plugin_read_entry,
            plugins::plugin_grants_load,
            plugins::plugin_grants_save,
            // Container
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
