//! Native application menu.
//!
//! Beyond discoverability, this matters most on macOS: without an application menu
//! there is no About, no Preferences, no Services/Hide — and, critically, no Edit
//! menu. On macOS the standard Edit menu is what actually wires up ⌘C/⌘V/⌘X/⌘A for
//! the webview, so its absence is why clipboard handling needed a polyfill.
//!
//! Custom items carry a julIDE command id and emit a `menu-command` event. The
//! frontend looks that id up in the same registry the command palette uses, so the
//! menu, the palette, and any keybinding all run one implementation. Only ids that
//! are actually registered in `builtinContributions.ts` appear here — a menu entry
//! that silently does nothing is worse than no entry at all.

use tauri::menu::{
    AboutMetadata, Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Emitted to the webview when a menu item is chosen.
const MENU_EVENT: &str = "menu-command";

const DOCS_URL: &str = "https://github.com/sinisterMage/julide#readme";
const ISSUES_URL: &str = "https://github.com/sinisterMage/julide/issues";

/// Menu item id prefix for entries that map to a frontend command.
/// The suffix is the command id, e.g. `cmd:julia.run`.
const CMD_PREFIX: &str = "cmd:";
/// Menu item id prefix for entries that open a URL.
const URL_PREFIX: &str = "url:";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    // Helper: a menu item that dispatches a frontend command.
    macro_rules! cmd_item {
        ($label:expr, $id:expr) => {
            MenuItemBuilder::with_id(format!("{}{}", CMD_PREFIX, $id), $label).build(app)?
        };
        ($label:expr, $id:expr, $accel:expr) => {
            MenuItemBuilder::with_id(format!("{}{}", CMD_PREFIX, $id), $label)
                .accelerator($accel)
                .build(app)?
        };
    }

    let about_metadata = AboutMetadata {
        name: Some("julIDE".into()),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        comments: Some("An IDE for the Julia programming language".into()),
        website: Some("https://github.com/sinisterMage/julide".into()),
        ..Default::default()
    };

    let mut menu = MenuBuilder::new(app);

    // ── App menu (macOS only) ────────────────────────────────────────────
    // On other platforms About and Quit live under Help and File respectively.
    #[cfg(target_os = "macos")]
    {
        let app_menu = SubmenuBuilder::new(app, "julIDE")
            .item(&PredefinedMenuItem::about(
                app,
                Some("About julIDE"),
                Some(about_metadata.clone()),
            )?)
            .separator()
            .item(&cmd_item!("Settings…", "settings.open", "CmdOrCtrl+,"))
            .separator()
            .item(&PredefinedMenuItem::services(app, None)?)
            .separator()
            .item(&PredefinedMenuItem::hide(app, None)?)
            .item(&PredefinedMenuItem::hide_others(app, None)?)
            .item(&PredefinedMenuItem::show_all(app, None)?)
            .separator()
            .item(&PredefinedMenuItem::quit(app, None)?)
            .build()?;
        menu = menu.item(&app_menu);
    }

    // ── File ─────────────────────────────────────────────────────────────
    let mut file = SubmenuBuilder::new(app, "File")
        .item(&cmd_item!(
            "Open Folder…",
            "file.open-folder",
            "CmdOrCtrl+O"
        ))
        .item(&cmd_item!("Go to File…", "file.quick-open", "CmdOrCtrl+P"))
        .separator()
        .item(&cmd_item!("Save", "file.save", "CmdOrCtrl+S"))
        .separator()
        .item(&cmd_item!(
            "New Julia Project…",
            "julia.new-project-pkgtemplates"
        ));

    #[cfg(not(target_os = "macos"))]
    {
        file = file
            .separator()
            .item(&cmd_item!("Settings…", "settings.open", "CmdOrCtrl+,"))
            .separator()
            .item(&PredefinedMenuItem::quit(app, Some("Exit"))?);
    }
    #[cfg(target_os = "macos")]
    {
        file = file
            .separator()
            .item(&PredefinedMenuItem::close_window(app, None)?);
    }
    menu = menu.item(&file.build()?);

    // ── Edit ─────────────────────────────────────────────────────────────
    // The predefined items are what give macOS working ⌘C/⌘V/⌘X/⌘A.
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .separator()
        .item(&cmd_item!("Find", "edit.find", "CmdOrCtrl+F"))
        .item(&cmd_item!("Replace", "edit.find-replace", "CmdOrCtrl+H"))
        .item(&cmd_item!(
            "Find in Files",
            "search.global",
            "CmdOrCtrl+Shift+F"
        ))
        .separator()
        .item(&cmd_item!(
            "Go to Line…",
            "editor.go-to-line",
            "CmdOrCtrl+G"
        ))
        .item(&cmd_item!("Format Document", "editor.format-document"))
        .build()?;
    menu = menu.item(&edit);

    // ── View ─────────────────────────────────────────────────────────────
    let view = SubmenuBuilder::new(app, "View")
        .item(&cmd_item!(
            "Command Palette…",
            "view.command-palette",
            "CmdOrCtrl+Shift+P"
        ))
        .separator()
        .item(&cmd_item!("Split Editor", "editor.split"))
        .separator()
        .item(&cmd_item!("Output", "panel.output"))
        .item(&cmd_item!("Terminal", "panel.terminal"))
        .item(&cmd_item!("Problems", "panel.problems"))
        .item(&cmd_item!("Plots", "plots.show"))
        .item(&cmd_item!("Tests", "tests.show"))
        .separator()
        .item(&cmd_item!("Outline", "outline.show"))
        .item(&cmd_item!("Variables", "variables.show"))
        .item(&cmd_item!("Source Control", "git.panel"))
        .item(&cmd_item!("Dev Containers", "container.panel"))
        .build()?;
    menu = menu.item(&view);

    // ── Run ──────────────────────────────────────────────────────────────
    let run = SubmenuBuilder::new(app, "Run")
        .item(&cmd_item!("Run File", "julia.run", "CmdOrCtrl+F5"))
        .item(&cmd_item!(
            "Run Cell",
            "editor.run-cell",
            "CmdOrCtrl+Return"
        ))
        .item(&cmd_item!("Stop", "julia.stop"))
        .separator()
        .item(&cmd_item!("Debug Panel", "panel.debug"))
        .separator()
        .item(&cmd_item!("Precompile Project", "julia.precompile"))
        .item(&cmd_item!("Clean Project", "julia.clean"))
        .separator()
        .item(&cmd_item!("Julia Setup…", "julia.setup"))
        .build()?;
    menu = menu.item(&run);

    // ── Help ─────────────────────────────────────────────────────────────
    let mut help = SubmenuBuilder::new(app, "Help")
        .item(
            &MenuItemBuilder::with_id(format!("{}{}", URL_PREFIX, DOCS_URL), "Documentation")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(format!("{}{}", URL_PREFIX, ISSUES_URL), "Report an Issue")
                .build(app)?,
        )
        .separator()
        .item(&cmd_item!("Check for Updates…", "app.check-for-updates"));

    #[cfg(not(target_os = "macos"))]
    {
        help = help.separator().item(&PredefinedMenuItem::about(
            app,
            Some("About julIDE"),
            Some(about_metadata),
        )?);
    }
    menu = menu.item(&help.build()?);

    menu.build()
}

/// Route a menu selection to the webview (or handle it natively).
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if let Some(url) = id.strip_prefix(URL_PREFIX) {
        use tauri_plugin_opener::OpenerExt;
        if let Err(e) = app.opener().open_url(url, None::<&str>) {
            eprintln!("Failed to open {}: {}", url, e);
        }
        return;
    }

    if let Some(command) = id.strip_prefix(CMD_PREFIX) {
        // The webview owns the command registry, so dispatch rather than
        // duplicating each action natively.
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.emit(MENU_EVENT, command);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_ids_round_trip_through_the_prefix() {
        let id = format!("{}{}", CMD_PREFIX, "julia.run");
        assert_eq!(id.strip_prefix(CMD_PREFIX), Some("julia.run"));
        assert_eq!(id.strip_prefix(URL_PREFIX), None);
    }

    #[test]
    fn url_ids_round_trip_through_the_prefix() {
        let id = format!("{}{}", URL_PREFIX, DOCS_URL);
        assert_eq!(id.strip_prefix(URL_PREFIX), Some(DOCS_URL));
        assert_eq!(id.strip_prefix(CMD_PREFIX), None);
    }

    #[test]
    fn prefixes_are_distinguishable() {
        // A command id must never be mistaken for a URL id or vice versa.
        assert!(!CMD_PREFIX.starts_with(URL_PREFIX));
        assert!(!URL_PREFIX.starts_with(CMD_PREFIX));
    }
}
