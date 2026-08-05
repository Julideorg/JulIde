use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub name: String,
    pub version: String,
    pub display_name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    pub main: String,
    #[serde(default)]
    pub activation_events: Vec<String>,
    /// Capabilities the plugin asks for. Anything not listed here is denied at the
    /// `ctx.ipc.invoke` boundary — see src/services/pluginPermissions.ts.
    #[serde(default)]
    pub permissions: Vec<String>,
}

/// Permissions the user has approved for a plugin, keyed by plugin name.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginGrant {
    pub permissions: Vec<String>,
    pub manifest_hash: String,
}

/// Reject anything that is not a single, plain directory name.
///
/// `plugin_read_entry` and friends join this into a path under `~/.julide/plugins/`,
/// so without this a caller could pass `../../../etc` and walk out of the plugin
/// directory entirely.
fn validate_plugin_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("Plugin name must not be empty".into());
    }
    if name.contains('\0') || name.chars().any(|c| c.is_ascii_control()) {
        return Err("Plugin name must not contain control characters".into());
    }
    // A valid plugin directory is exactly one path component with no traversal.
    let mut components = Path::new(name).components();
    let only = components.next();
    if components.next().is_some() {
        return Err(format!(
            "Invalid plugin name '{}': must be a single path component",
            name
        ));
    }
    match only {
        Some(std::path::Component::Normal(c)) if c == std::ffi::OsStr::new(name) => Ok(()),
        _ => Err(format!(
            "Invalid plugin name '{}': must not contain path separators or traversal",
            name
        )),
    }
}

fn plugins_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".julide").join("plugins")
}

#[tauri::command]
pub fn plugin_get_dir() -> String {
    let dir = plugins_dir();
    // Create if it doesn't exist
    std::fs::create_dir_all(&dir).ok();
    dir.to_string_lossy().to_string()
}

#[tauri::command]
pub fn plugin_scan() -> Result<Vec<PluginManifest>, String> {
    let dir = plugins_dir();
    if !dir.exists() {
        std::fs::create_dir_all(&dir).ok();
        return Ok(Vec::new());
    }

    let mut manifests = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let manifest_path = path.join("plugin.json");
        if !manifest_path.exists() {
            continue;
        }

        match std::fs::read_to_string(&manifest_path) {
            Ok(content) => match serde_json::from_str::<PluginManifest>(&content) {
                Ok(manifest) => manifests.push(manifest),
                Err(e) => eprintln!("Failed to parse {}: {}", manifest_path.display(), e),
            },
            Err(e) => eprintln!("Failed to read {}: {}", manifest_path.display(), e),
        }
    }
    Ok(manifests)
}

#[tauri::command]
pub fn plugin_read_entry(plugin_name: String) -> Result<String, String> {
    validate_plugin_name(&plugin_name)?;
    let dir = plugins_dir();
    let plugin_root = dir.join(&plugin_name);
    let manifest_path = plugin_root.join("plugin.json");
    let content = std::fs::read_to_string(&manifest_path).map_err(|e| e.to_string())?;
    let manifest: PluginManifest = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let entry_path = plugin_root.join(&manifest.main);

    // `main` comes from the manifest, so it is attacker-controlled in the same way the
    // plugin name is. Confine the resolved entry point to the plugin's own directory.
    let canonical_root = plugin_root.canonicalize().map_err(|e| {
        format!(
            "Plugin directory {} is unreadable: {}",
            plugin_root.display(),
            e
        )
    })?;
    let canonical_entry = entry_path
        .canonicalize()
        .map_err(|e| format!("Plugin entry {} is unreadable: {}", entry_path.display(), e))?;
    if !canonical_entry.starts_with(&canonical_root) {
        return Err(format!(
            "Plugin '{}' declares an entry point outside its own directory",
            plugin_name
        ));
    }

    std::fs::read_to_string(&canonical_entry).map_err(|e| {
        format!(
            "Failed to read plugin entry {}: {}",
            canonical_entry.display(),
            e
        )
    })
}

fn grants_path() -> PathBuf {
    let config = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    config.join("julide").join("plugin-grants.json")
}

/// Load the user's plugin permission grants.
///
/// Kept in its own file rather than settings.json so that a corrupt or hand-edited
/// settings file cannot silently drop permission decisions, and so the blast radius of
/// a parse failure is "re-prompt the user" rather than "reset every preference".
#[tauri::command]
pub fn plugin_grants_load() -> HashMap<String, PluginGrant> {
    match std::fs::read_to_string(grants_path()) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

#[tauri::command]
pub fn plugin_grants_save(grants: HashMap<String, PluginGrant>) -> Result<(), String> {
    let path = grants_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_string_pretty(&grants).map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_serde_round_trip() {
        let manifest = PluginManifest {
            name: "test-plugin".to_string(),
            version: "1.0.0".to_string(),
            display_name: "Test Plugin".to_string(),
            description: Some("A test plugin".to_string()),
            author: Some("Author".to_string()),
            main: "dist/index.js".to_string(),
            activation_events: vec!["*".to_string()],
            permissions: vec!["workspace:read".to_string()],
        };

        let json = serde_json::to_string(&manifest).unwrap();
        let deserialized: PluginManifest = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.name, "test-plugin");
        assert_eq!(deserialized.version, "1.0.0");
        assert_eq!(deserialized.display_name, "Test Plugin");
        assert_eq!(deserialized.main, "dist/index.js");
        assert_eq!(deserialized.activation_events, vec!["*"]);
    }

    #[test]
    fn manifest_camel_case_deserialization() {
        let json = r#"{
            "name": "my-plugin",
            "version": "0.1.0",
            "displayName": "My Plugin",
            "main": "index.js",
            "activationEvents": ["*"]
        }"#;

        let manifest: PluginManifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.name, "my-plugin");
        assert_eq!(manifest.display_name, "My Plugin");
        assert_eq!(manifest.activation_events, vec!["*"]);
    }

    // ── validate_plugin_name: path traversal ────────────────────────────────

    #[test]
    fn plugin_name_accepts_plain_names() {
        assert!(validate_plugin_name("my-plugin").is_ok());
        assert!(validate_plugin_name("julia_fmt").is_ok());
        assert!(validate_plugin_name("Plugin.With.Dots").is_ok());
    }

    #[test]
    fn plugin_name_rejects_traversal() {
        // This is the case that escaped ~/.julide/plugins/ before.
        assert!(validate_plugin_name("../../../etc").is_err());
        assert!(validate_plugin_name("..").is_err());
        assert!(validate_plugin_name("a/b").is_err());
        assert!(validate_plugin_name("./x").is_err());
    }

    #[test]
    fn plugin_name_rejects_absolute_paths() {
        assert!(validate_plugin_name("/etc/passwd").is_err());
    }

    #[test]
    fn plugin_name_rejects_empty_and_control_chars() {
        assert!(validate_plugin_name("").is_err());
        assert!(validate_plugin_name("bad\0name").is_err());
        assert!(validate_plugin_name("bad\nname").is_err());
    }

    #[test]
    fn plugin_read_entry_rejects_traversal_name() {
        let err = plugin_read_entry("../../../etc".to_string()).unwrap_err();
        assert!(err.contains("Invalid plugin name"), "got: {err}");
    }

    // ── grants ─────────────────────────────────────────────────────────────

    #[test]
    fn grant_serde_round_trip() {
        let mut grants = HashMap::new();
        grants.insert(
            "my-plugin".to_string(),
            PluginGrant {
                permissions: vec!["workspace:read".to_string(), "julia:run".to_string()],
                manifest_hash: "deadbeef".to_string(),
            },
        );

        let json = serde_json::to_string(&grants).unwrap();
        // camelCase on the wire so it matches the TS PluginGrant interface.
        assert!(json.contains("manifestHash"), "got: {json}");

        let back: HashMap<String, PluginGrant> = serde_json::from_str(&json).unwrap();
        assert_eq!(back["my-plugin"].permissions.len(), 2);
        assert_eq!(back["my-plugin"].manifest_hash, "deadbeef");
    }

    #[test]
    fn manifest_permissions_default_to_empty() {
        // A manifest that declares nothing gets nothing — the model fails closed.
        let json = r#"{
            "name": "minimal",
            "version": "1.0.0",
            "displayName": "Minimal",
            "main": "index.js"
        }"#;
        let manifest: PluginManifest = serde_json::from_str(json).unwrap();
        assert!(manifest.permissions.is_empty());
    }

    #[test]
    fn manifest_optional_fields_default() {
        let json = r#"{
            "name": "minimal",
            "version": "1.0.0",
            "displayName": "Minimal",
            "main": "index.js"
        }"#;

        let manifest: PluginManifest = serde_json::from_str(json).unwrap();
        assert!(manifest.description.is_none());
        assert!(manifest.author.is_none());
        assert!(manifest.activation_events.is_empty());
    }
}
