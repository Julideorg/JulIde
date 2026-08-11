use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_font_size")]
    pub font_size: u32,
    #[serde(default = "default_font_family")]
    pub font_family: String,
    #[serde(default = "default_tab_size")]
    pub tab_size: u32,
    #[serde(default = "default_true")]
    pub minimap_enabled: bool,
    #[serde(default = "default_word_wrap")]
    pub word_wrap: String,
    /// Write the file a moment after typing stops.
    ///
    /// Off by default. Existing installs keep whatever they already have on disk —
    /// `settings_save` writes every field, so they all carry `autoSave: true` — because
    /// switching autosave off under someone relying on it loses work rather than fixing
    /// anything.
    #[serde(default)]
    pub auto_save: bool,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_terminal_font_size")]
    pub terminal_font_size: u32,
    #[serde(default)]
    pub recent_workspaces: Vec<String>,
    #[serde(default = "default_container_runtime")]
    pub container_runtime: String,
    #[serde(default)]
    pub container_remote_host: String,
    #[serde(default = "default_true")]
    pub container_auto_detect: bool,
    #[serde(default = "default_true")]
    pub display_forwarding: bool,
    #[serde(default)]
    pub gpu_passthrough: bool,
    #[serde(default = "default_true")]
    pub selinux_label: bool,
    #[serde(default = "default_true")]
    pub persist_julia_packages: bool,
    #[serde(default = "default_pluto_port")]
    pub pluto_port: u32,
    #[serde(default)]
    pub julia_path: String,
    #[serde(default = "default_lsp_backend")]
    pub lsp_backend: String,
    /// Target line length Fatou formats to. Ignored by the Julia-hosted backends.
    #[serde(default = "default_fatou_line_width")]
    pub fatou_line_width: u32,
    /// Spaces per indent level Fatou formats with.
    #[serde(default = "default_fatou_indent_width")]
    pub fatou_indent_width: u32,
    /// Format the file through the language server before an explicit save.
    #[serde(default)]
    pub format_on_save: bool,
    /// Bumped when a stored `settings.json` needs rewriting; see [`Settings::migrated`].
    #[serde(default)]
    pub settings_version: u32,
    #[serde(default = "default_true")]
    pub start_maximized: bool,
    /// Show text labels under the activity bar icons.
    ///
    /// Existed on the TypeScript side only until 0.4.2, so `settings_save` — which
    /// writes the whole struct — dropped it on every write and the toggle reset itself
    /// on restart.
    #[serde(default = "default_true")]
    pub activity_bar_labels: bool,
    /// Sidebar width in pixels. Persisted so a resized layout survives a restart.
    #[serde(default = "default_sidebar_width")]
    pub sidebar_width: u32,
    /// Bottom panel height in pixels.
    #[serde(default = "default_bottom_panel_height")]
    pub bottom_panel_height: u32,
    /// Render images stored in the open workspace (relative paths in markdown).
    ///
    /// Off by default. Reads bytes off disk under the workspace root and hands them to
    /// the webview as a blob — no network, and traversal outside the root is refused.
    #[serde(default)]
    pub allow_local_images: bool,
    /// Render `https://` images in markdown.
    ///
    /// Off by default, and deliberately separate from [`Self::allow_local_images`]:
    /// this one leaks the reader's IP address and read time to whoever hosts the image,
    /// which viewing a cloned repository's README should not do silently.
    #[serde(default)]
    pub allow_remote_images: bool,
    /// Interface zoom, as a webview scale factor. 1.0 is 100%.
    ///
    /// Scales the whole window — chrome, editor and terminal alike — because it is
    /// applied by the webview itself rather than by the stylesheet. Distinct from
    /// [`Self::font_size`], which is the editor's text and nothing else.
    #[serde(default = "default_ui_zoom")]
    pub ui_zoom: f32,
    /// Write julIDE's own interface in plain ASCII, and stop the editor drawing ligatures.
    ///
    /// Nothing in Rust reads this — it is stored here because `settings_save` serialises
    /// the whole struct, so a field that lived only on the TypeScript side would be
    /// dropped on every write. See [`Self::activity_bar_labels`], which was exactly that
    /// bug until 0.4.2.
    #[serde(default)]
    pub ascii_only: bool,
}

fn default_font_size() -> u32 {
    14
}

fn default_ui_zoom() -> f32 {
    1.0
}
fn default_sidebar_width() -> u32 {
    240
}
fn default_bottom_panel_height() -> u32 {
    200
}
fn default_pluto_port() -> u32 {
    3000
}
fn default_font_family() -> String {
    "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Noto Sans Mono', monospace".into()
}
fn default_tab_size() -> u32 {
    4
}
fn default_true() -> bool {
    true
}
fn default_word_wrap() -> String {
    "off".into()
}
fn default_theme() -> String {
    "julide-dark".into()
}
fn default_terminal_font_size() -> u32 {
    13
}
fn default_container_runtime() -> String {
    "auto".into()
}
fn default_lsp_backend() -> String {
    "fatou".into()
}
fn default_fatou_line_width() -> u32 {
    92
}
fn default_fatou_indent_width() -> u32 {
    4
}

/// Current `settings_version`. Bump when a migration is added below.
const SETTINGS_VERSION: u32 = 1;

impl Default for Settings {
    fn default() -> Self {
        Settings {
            font_size: default_font_size(),
            font_family: default_font_family(),
            tab_size: default_tab_size(),
            minimap_enabled: default_true(),
            word_wrap: default_word_wrap(),
            auto_save: false,
            theme: default_theme(),
            terminal_font_size: default_terminal_font_size(),
            recent_workspaces: Vec::new(),
            container_runtime: default_container_runtime(),
            container_remote_host: String::new(),
            container_auto_detect: default_true(),
            display_forwarding: default_true(),
            gpu_passthrough: false,
            selinux_label: default_true(),
            persist_julia_packages: default_true(),
            pluto_port: default_pluto_port(),
            julia_path: String::new(),
            lsp_backend: default_lsp_backend(),
            fatou_line_width: default_fatou_line_width(),
            fatou_indent_width: default_fatou_indent_width(),
            format_on_save: false,
            settings_version: SETTINGS_VERSION,
            start_maximized: default_true(),
            activity_bar_labels: default_true(),
            sidebar_width: default_sidebar_width(),
            bottom_panel_height: default_bottom_panel_height(),
            allow_local_images: false,
            allow_remote_images: false,
            ui_zoom: default_ui_zoom(),
            ascii_only: false,
        }
    }
}

impl Settings {
    /// Bring out-of-range values back into a usable range.
    ///
    /// The UI enforces min/max on its inputs, but `settings.json` is a plain file a
    /// user can hand-edit — and a `fontSize` of 99999 or a `plutoPort` of 0 renders
    /// the app unusable with no obvious way back. Clamping on both load and save
    /// makes a bad value self-healing rather than a trap.
    pub fn clamped(mut self) -> Self {
        self.font_size = self.font_size.clamp(6, 72);
        self.terminal_font_size = self.terminal_font_size.clamp(6, 72);
        self.tab_size = self.tab_size.clamp(1, 16);
        // Port 0 means "any port" to the OS but breaks the URL julIDE builds;
        // ports below 1024 need privileges we do not have.
        self.pluto_port = self.pluto_port.clamp(1024, 65535);
        self.sidebar_width = self.sidebar_width.clamp(150, 800);
        self.bottom_panel_height = self.bottom_panel_height.clamp(80, 1200);
        // A zoom of 0 — or NaN, which a hand-edited `null` deserializes into — leaves a
        // window that cannot be read or clicked back to normal. `is_finite` first,
        // because `clamp` panics on NaN rather than correcting it.
        if !self.ui_zoom.is_finite() {
            self.ui_zoom = default_ui_zoom();
        }
        self.ui_zoom = self.ui_zoom.clamp(0.5, 3.0);

        if !matches!(
            self.word_wrap.as_str(),
            "off" | "on" | "wordWrapColumn" | "bounded"
        ) {
            self.word_wrap = default_word_wrap();
        }
        if !matches!(self.theme.as_str(), "julide-dark" | "julide-light") {
            self.theme = default_theme();
        }
        if !matches!(
            self.container_runtime.as_str(),
            "auto" | "docker" | "podman"
        ) {
            self.container_runtime = default_container_runtime();
        }
        if !matches!(
            self.lsp_backend.as_str(),
            "fatou" | "languageserver" | "jetls"
        ) {
            self.lsp_backend = default_lsp_backend();
        }
        self.fatou_line_width = self.fatou_line_width.clamp(40, 200);
        self.fatou_indent_width = self.fatou_indent_width.clamp(1, 8);

        // A recent list that grew unbounded through hand-editing would slow startup.
        self.recent_workspaces.truncate(10);
        self
    }

    /// Apply one-time upgrades to a settings file written by an older build.
    ///
    /// Changing a `#[serde(default)]` only reaches users who have never saved
    /// that field, and `settings_save` writes every field — so every existing
    /// install has `lspBackend` on disk and would keep the old backend forever.
    /// Version 1 moves those users onto Fatou once. A backend chosen
    /// deliberately after this point is written at the current version and is
    /// never touched again.
    fn migrated(mut self) -> Self {
        if self.settings_version < 1 && self.lsp_backend == "languageserver" {
            self.lsp_backend = default_lsp_backend();
        }
        self.settings_version = SETTINGS_VERSION;
        self
    }
}

fn settings_path() -> PathBuf {
    let config = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    config.join("julide").join("settings.json")
}

/// True once tauri-plugin-window-state has stored a geometry for this app.
///
/// Used to stop `start_maximized` from stomping on a window size the user chose:
/// the setting should describe the *first* launch, not override every later one.
pub fn has_saved_window_state() -> bool {
    let Some(dir) = dirs::config_dir() else {
        return false;
    };
    // The plugin writes this next to the app's other config, keyed by identifier.
    dir.join("com.ofek.julide")
        .join(".window-state.json")
        .exists()
}

#[tauri::command]
pub fn settings_load() -> Settings {
    let path = settings_path();
    if let Ok(content) = fs::read_to_string(&path) {
        serde_json::from_str::<Settings>(&content)
            .unwrap_or_default()
            .migrated()
            .clamped()
    } else {
        Settings::default()
    }
}

#[tauri::command]
pub fn settings_save(settings: Settings) -> Result<(), String> {
    let settings = settings.clamped();
    let path = settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    // Write to a temporary file and rename over the target, so an interrupted write
    // (crash, full disk, power loss) cannot leave a truncated settings.json behind —
    // which on next launch would silently reset every preference.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn settings_add_recent_workspace(workspace_path: String) -> Result<(), String> {
    let mut settings = settings_load();
    settings.recent_workspaces.retain(|w| w != &workspace_path);
    settings.recent_workspaces.insert(0, workspace_path);
    settings.recent_workspaces.truncate(10);
    settings_save(settings)
}

/// Drop an entry from the recent list — used when opening it fails because the
/// directory was moved or deleted, so the welcome screen stops offering a dead link.
#[tauri::command]
pub fn settings_remove_recent_workspace(workspace_path: String) -> Result<(), String> {
    let mut settings = settings_load();
    settings.recent_workspaces.retain(|w| w != &workspace_path);
    settings_save(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_settings_values() {
        let s = Settings::default();
        assert_eq!(s.font_size, 14);
        assert_eq!(s.tab_size, 4);
        assert_eq!(s.theme, "julide-dark");
        assert!(s.minimap_enabled);
        assert_eq!(s.word_wrap, "off");
        // Off for a fresh install, so an unsaved file stays visibly unsaved. An install
        // that already has `autoSave: true` on disk keeps it — see the field's docs.
        assert!(!s.auto_save);
        assert_eq!(s.terminal_font_size, 13);
        assert_eq!(s.container_runtime, "auto");
        assert_eq!(s.pluto_port, 3000);
        assert_eq!(s.lsp_backend, "fatou");
        assert_eq!(s.fatou_line_width, 92);
        assert_eq!(s.fatou_indent_width, 4);
        assert!(!s.format_on_save);
        assert!(s.recent_workspaces.is_empty());
        // Both image escape hatches are opt-in: the default posture must stay closed.
        assert!(!s.allow_local_images);
        assert!(!s.allow_remote_images);
        assert!(!s.ascii_only);
    }

    #[test]
    fn ascii_only_survives_a_save() {
        // The field exists in Rust purely so serde does not drop it: settings_save
        // serialises the whole struct, which is how activityBarLabels used to reset
        // itself on every restart.
        let json = serde_json::to_string(&Settings {
            ascii_only: true,
            ..Default::default()
        })
        .unwrap();
        assert!(json.contains("asciiOnly"), "got: {json}");
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert!(back.ascii_only);

        // Absent from every settings file written before this existed: read as off.
        let old: Settings = serde_json::from_str(r#"{"fontSize": 16}"#).unwrap();
        assert!(!old.ascii_only);
    }

    #[test]
    fn activity_bar_labels_survives_a_save() {
        // It used to exist only in the TS Settings interface, so serde silently dropped
        // it from every settings_save and the toggle reset itself on restart.
        let json = serde_json::to_string(&Settings {
            activity_bar_labels: false,
            ..Default::default()
        })
        .unwrap();
        assert!(json.contains("activityBarLabels"), "got: {json}");
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert!(!back.activity_bar_labels);
        // Absent from an older file means "on", matching the TS default.
        let old: Settings = serde_json::from_str(r#"{"fontSize": 16}"#).unwrap();
        assert!(old.activity_bar_labels);
    }

    #[test]
    fn image_settings_default_off_for_existing_installs() {
        // `settings_save` writes every field, so every existing install has a settings
        // file without these keys. They must read as false rather than failing to parse.
        let s: Settings = serde_json::from_str(r#"{"fontSize": 16}"#).unwrap();
        assert!(!s.allow_local_images);
        assert!(!s.allow_remote_images);

        let json = serde_json::to_string(&Settings::default()).unwrap();
        assert!(json.contains("allowLocalImages"), "got: {json}");
        assert!(json.contains("allowRemoteImages"), "got: {json}");
    }

    #[test]
    fn ui_zoom_defaults_to_100_percent_and_is_clamped() {
        // Absent from every settings file written before zoom existed.
        let s: Settings = serde_json::from_str(r#"{"fontSize": 16}"#).unwrap();
        assert_eq!(s.ui_zoom, 1.0);

        let json = serde_json::to_string(&Settings::default()).unwrap();
        assert!(json.contains("uiZoom"), "got: {json}");

        // A hand-edited file must not be able to leave a window that cannot be read.
        let tiny = Settings {
            ui_zoom: 0.0001,
            ..Default::default()
        }
        .clamped();
        assert_eq!(tiny.ui_zoom, 0.5);
        let huge = Settings {
            ui_zoom: 40.0,
            ..Default::default()
        }
        .clamped();
        assert_eq!(huge.ui_zoom, 3.0);
        // clamp panics on NaN, so it has to be caught before we get there.
        let nan = Settings {
            ui_zoom: f32::NAN,
            ..Default::default()
        }
        .clamped();
        assert_eq!(nan.ui_zoom, 1.0);
    }

    #[test]
    fn layout_fields_default_when_absent() {
        // Settings files written before layout persistence existed must still load.
        let json = r#"{"fontSize": 16}"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(s.font_size, 16);
        assert_eq!(s.sidebar_width, default_sidebar_width());
        assert_eq!(s.bottom_panel_height, default_bottom_panel_height());
    }

    #[test]
    fn layout_fields_serialise_as_camel_case() {
        // The TS Settings interface reads sidebarWidth / bottomPanelHeight.
        let json = serde_json::to_string(&Settings::default()).unwrap();
        assert!(json.contains("sidebarWidth"), "got: {json}");
        assert!(json.contains("bottomPanelHeight"), "got: {json}");
    }

    // ── clamped() ──────────────────────────────────────────────────────────

    #[test]
    fn clamped_brings_absurd_sizes_back_into_range() {
        let s = Settings {
            font_size: 99999,
            terminal_font_size: 0,
            tab_size: 0,
            ..Default::default()
        }
        .clamped();
        assert_eq!(s.font_size, 72);
        assert_eq!(s.terminal_font_size, 6);
        assert_eq!(s.tab_size, 1);
    }

    #[test]
    fn clamped_rejects_unusable_pluto_ports() {
        // 0 means "any port" to the OS, but julIDE builds a URL from this value.
        assert_eq!(
            Settings {
                pluto_port: 0,
                ..Default::default()
            }
            .clamped()
            .pluto_port,
            1024
        );
        assert_eq!(
            Settings {
                pluto_port: 999_999,
                ..Default::default()
            }
            .clamped()
            .pluto_port,
            65535
        );
    }

    #[test]
    fn clamped_falls_back_on_unknown_enum_values() {
        let s = Settings {
            theme: "hot-pink".into(),
            word_wrap: "sideways".into(),
            container_runtime: "containerd".into(),
            lsp_backend: "nonesuch".into(),
            ..Default::default()
        }
        .clamped();
        assert_eq!(s.theme, default_theme());
        assert_eq!(s.word_wrap, default_word_wrap());
        assert_eq!(s.container_runtime, default_container_runtime());
        assert_eq!(s.lsp_backend, default_lsp_backend());
    }

    #[test]
    fn clamped_keeps_valid_values_untouched() {
        let original = Settings {
            font_size: 15,
            theme: "julide-light".into(),
            word_wrap: "on".into(),
            container_runtime: "podman".into(),
            lsp_backend: "jetls".into(),
            pluto_port: 3000,
            ..Default::default()
        };
        let clamped = original.clone().clamped();
        assert_eq!(clamped.font_size, 15);
        assert_eq!(clamped.theme, "julide-light");
        assert_eq!(clamped.word_wrap, "on");
        assert_eq!(clamped.container_runtime, "podman");
        assert_eq!(clamped.lsp_backend, "jetls");
        assert_eq!(clamped.pluto_port, 3000);
    }

    #[test]
    fn clamped_caps_the_recent_workspace_list() {
        let s = Settings {
            recent_workspaces: (0..50).map(|i| format!("/w{i}")).collect(),
            ..Default::default()
        }
        .clamped();
        assert_eq!(s.recent_workspaces.len(), 10);
    }

    #[test]
    fn clamped_bounds_fatou_format_widths() {
        let s = Settings {
            fatou_line_width: 5,
            fatou_indent_width: 99,
            ..Default::default()
        }
        .clamped();
        assert_eq!(s.fatou_line_width, 40);
        assert_eq!(s.fatou_indent_width, 8);
    }

    // ── migrated() ─────────────────────────────────────────────────────────

    #[test]
    fn migration_moves_pre_existing_installs_onto_fatou() {
        // Everyone who ran an older build has "languageserver" written to disk,
        // so a changed serde default alone would never reach them.
        let stored = Settings {
            lsp_backend: "languageserver".into(),
            settings_version: 0,
            ..Default::default()
        };
        let migrated = stored.migrated();
        assert_eq!(migrated.lsp_backend, "fatou");
        assert_eq!(migrated.settings_version, SETTINGS_VERSION);
    }

    #[test]
    fn migration_leaves_other_backends_alone() {
        let stored = Settings {
            lsp_backend: "jetls".into(),
            settings_version: 0,
            ..Default::default()
        };
        assert_eq!(stored.migrated().lsp_backend, "jetls");
    }

    #[test]
    fn migration_does_not_undo_a_deliberate_choice() {
        // Picking LanguageServer.jl after migrating stores the current version,
        // which must stop the migration from reverting it on the next launch.
        let chosen = Settings {
            lsp_backend: "languageserver".into(),
            settings_version: SETTINGS_VERSION,
            ..Default::default()
        };
        assert_eq!(chosen.migrated().lsp_backend, "languageserver");
    }

    #[test]
    fn clamped_bounds_panel_sizes() {
        let s = Settings {
            sidebar_width: 5,
            bottom_panel_height: 99999,
            ..Default::default()
        }
        .clamped();
        assert_eq!(s.sidebar_width, 150);
        assert_eq!(s.bottom_panel_height, 1200);
    }

    #[test]
    fn serde_round_trip() {
        let settings = Settings::default();
        let json = serde_json::to_string(&settings).unwrap();
        let deserialized: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.font_size, settings.font_size);
        assert_eq!(deserialized.theme, settings.theme);
        assert_eq!(deserialized.pluto_port, settings.pluto_port);
    }

    #[test]
    fn deserialize_partial_json_gets_defaults() {
        let json = r#"{"fontSize": 20, "theme": "julide-light"}"#;
        let settings: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(settings.font_size, 20);
        assert_eq!(settings.theme, "julide-light");
        // Missing fields should get defaults
        assert_eq!(settings.tab_size, 4);
        assert!(settings.minimap_enabled);
        assert_eq!(settings.pluto_port, 3000);
    }

    #[test]
    fn camel_case_serialization() {
        let settings = Settings::default();
        let json = serde_json::to_string(&settings).unwrap();
        // serde(rename_all = "camelCase") should produce camelCase keys
        assert!(json.contains("\"fontSize\""));
        assert!(json.contains("\"tabSize\""));
        assert!(json.contains("\"minimapEnabled\""));
        assert!(json.contains("\"wordWrap\""));
        assert!(json.contains("\"autoSave\""));
        assert!(json.contains("\"terminalFontSize\""));
        // Should NOT contain snake_case
        assert!(!json.contains("\"font_size\""));
        assert!(!json.contains("\"tab_size\""));
    }
}
