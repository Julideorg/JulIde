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
        if !matches!(self.lsp_backend.as_str(), "languageserver" | "jetls") {
            self.lsp_backend = default_lsp_backend();
        }

        // A recent list that grew unbounded through hand-editing would slow startup.
        self.recent_workspaces.truncate(10);
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
