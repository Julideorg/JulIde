mod container;
mod debugger;
mod fs;
mod git;
mod git_auth;
mod git_gitea;
mod git_github;
mod git_gitlab;
mod git_provider;
mod julia;
mod lsp;
mod plugins;
mod pluto;
mod pty;
mod search;
mod settings;
mod sync;
mod watcher;

use julia::new_julia_state;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // The shell and fs plugins are deliberately not registered: the frontend
        // never uses them (all such work goes through the commands below), and
        // registering them only widens what a compromised webview could reach.
        // dialog is registered because fs.rs drives the native pickers from Rust.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(new_julia_state())
        .setup(|app| {
            let settings = crate::settings::settings_load();
            if settings.start_maximized {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.maximize();
                }
            }
            Ok(())
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
