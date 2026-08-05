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
    #[serde(default = "default_true")]
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
    #[serde(default = "default_true")]
    pub start_maximized: bool,
    /// Sidebar width in pixels. Persisted so a resized layout survives a restart.
    #[serde(default = "default_sidebar_width")]
    pub sidebar_width: u32,
    /// Bottom panel height in pixels.
    #[serde(default = "default_bottom_panel_height")]
    pub bottom_panel_height: u32,
}

fn default_font_size() -> u32 {
    14
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
    "languageserver".into()
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            font_size: default_font_size(),
            font_family: default_font_family(),
            tab_size: default_tab_size(),
            minimap_enabled: default_true(),
            word_wrap: default_word_wrap(),
            auto_save: default_true(),
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
            start_maximized: default_true(),
            sidebar_width: default_sidebar_width(),
            bottom_panel_height: default_bottom_panel_height(),
        }
    }
}

fn settings_path() -> PathBuf {
    let config = dirs_next::config_dir().unwrap_or_else(|| PathBuf::from("."));
    config.join("julide").join("settings.json")
}

/// True once tauri-plugin-window-state has stored a geometry for this app.
///
/// Used to stop `start_maximized` from stomping on a window size the user chose:
/// the setting should describe the *first* launch, not override every later one.
pub fn has_saved_window_state() -> bool {
    let Some(dir) = dirs_next::config_dir() else {
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
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        Settings::default()
    }
}

#[tauri::command]
pub fn settings_save(settings: Settings) -> Result<(), String> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&path, content).map_err(|e| e.to_string())
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
        assert!(s.auto_save);
        assert_eq!(s.terminal_font_size, 13);
        assert_eq!(s.container_runtime, "auto");
        assert_eq!(s.pluto_port, 3000);
        assert_eq!(s.lsp_backend, "languageserver");
        assert!(s.recent_workspaces.is_empty());
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
