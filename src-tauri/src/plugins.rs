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
    /// Which generation of the plugin API this targets. Absent means 1 — the
    /// pre-sandbox API, where a plugin ran in julIDE's own realm.
    #[serde(default = "default_api_version")]
    pub api_version: u32,
    #[serde(default)]
    pub activation_events: Vec<String>,
    /// Capabilities the plugin asks for. Anything not listed here is denied at the
    /// `ctx.ipc.invoke` boundary — see src/services/pluginPermissions.ts.
    #[serde(default)]
    pub permissions: Vec<String>,
    /// Origins the plugin may reach. Becomes the `connect-src` of its sandbox frame,
    /// so an undeclared host is unreachable rather than merely undocumented.
    #[serde(default)]
    pub network: Vec<String>,
    /// Declarative contributions. Views must be known before the plugin's code runs —
    /// that is what lets a view frame be created lazily on first show.
    #[serde(default)]
    pub contributes: Option<serde_json::Value>,
}

fn default_api_version() -> u32 {
    1
}

/// Permissions the user has approved for a plugin, keyed by plugin name.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginGrant {
    pub permissions: Vec<String>,
    /// Origins the user approved this plugin to reach. Optional so grants written
    /// before the field existed still load rather than resetting every approval.
    #[serde(default)]
    pub network: Vec<String>,
    pub manifest_hash: String,
}

/// Reject anything that is not a single, plain directory name.
///
/// The name is joined into a path under `~/.julide/plugins/` by the plugin protocol
/// handler, so without this a caller could pass `../../../etc` and walk out of the
/// plugin directory entirely.
///
/// `pub(crate)` because archive extraction applies the same rule to every member of a
/// downloaded bundle. One implementation, so the two cannot drift apart.
pub(crate) fn validate_plugin_name(name: &str) -> Result<(), String> {
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
    scan_dir(&dir)
}

/// The body of `plugin_scan`, taking the directory as an argument so it can be tested
/// against a fixture tree rather than against the user's real `~/.julide/plugins`.
fn scan_dir(dir: &Path) -> Result<Vec<PluginManifest>, String> {
    let mut manifests = Vec::new();
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
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

        // The directory name is the plugin's identity everywhere else: it is what
        // the protocol handler resolves and what the frontend keys grants by. A manifest
        // is free to declare a different `name`, and then a plugin in `evil/` claiming
        // `"name": "trusted-plugin"` would be handed the grants the user approved for
        // the real one. Bind the two together here, at the only place both are visible.
        let dir_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => {
                eprintln!(
                    "Skipping plugin directory with a non-UTF-8 name: {}",
                    path.display()
                );
                continue;
            }
        };

        match std::fs::read_to_string(&manifest_path) {
            Ok(content) => match serde_json::from_str::<PluginManifest>(&content) {
                Ok(manifest) => {
                    if manifest.name != dir_name {
                        eprintln!(
                            "Skipping {}: manifest declares name '{}' but lives in directory '{}'",
                            manifest_path.display(),
                            manifest.name,
                            dir_name
                        );
                        continue;
                    }
                    if let Err(e) = validate_plugin_name(&manifest.name) {
                        eprintln!("Skipping {}: {}", manifest_path.display(), e);
                        continue;
                    }
                    manifests.push(manifest);
                }
                Err(e) => eprintln!("Failed to parse {}: {}", manifest_path.display(), e),
            },
            Err(e) => eprintln!("Failed to read {}: {}", manifest_path.display(), e),
        }
    }
    Ok(manifests)
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
    write_grants(&grants_path(), &grants)
}

/// The body of `plugin_grants_save`, taking the path so it can be tested.
///
/// Temp file plus rename, the same way `settings_save` does it. This file holds every
/// permission decision the user has ever made, and it is rewritten in full on every
/// grant and revoke — an interrupted write would drop the lot, and the user would be
/// re-prompted for everything at next launch with no indication why.
fn write_grants(path: &Path, grants: &HashMap<String, PluginGrant>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_string_pretty(grants).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
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
            api_version: 2,
            activation_events: vec!["*".to_string()],
            permissions: vec!["workspace:read".to_string()],
            network: vec![],
            contributes: None,
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

    // ── scan_dir: the manifest name must match the directory ───────────────

    /// Write `plugins/<dir>/plugin.json` declaring `name`.
    fn write_plugin(root: &Path, dir: &str, name: &str) {
        let plugin_dir = root.join(dir);
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            format!(r#"{{"name":"{name}","version":"1.0.0","displayName":"X","main":"index.js"}}"#),
        )
        .unwrap();
    }

    #[test]
    fn scan_accepts_a_plugin_whose_name_matches_its_directory() {
        let tmp = tempfile::tempdir().unwrap();
        write_plugin(tmp.path(), "good-plugin", "good-plugin");

        let found = scan_dir(tmp.path()).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "good-plugin");
    }

    #[test]
    fn scan_rejects_a_manifest_that_claims_another_plugin_s_name() {
        // Grants are keyed by `manifest.name`, so a plugin dropped into `evil/` while
        // declaring `"name": "trusted-plugin"` would otherwise be handed whatever the
        // user approved for the real trusted-plugin — with no prompt, because the
        // manifest hash would match too.
        let tmp = tempfile::tempdir().unwrap();
        write_plugin(tmp.path(), "evil", "trusted-plugin");

        let found = scan_dir(tmp.path()).unwrap();
        assert!(
            found.is_empty(),
            "impersonating manifest was returned: {found:?}"
        );
    }

    #[test]
    fn scan_rejects_a_name_that_is_not_a_plain_directory_name() {
        // A directory name matching the manifest is necessary but not sufficient: on
        // Unix a name may contain almost anything, including a newline, and that name
        // then flows into grant keys and log lines. Reject it at the scan rather than
        // letting plugin_read_entry be the only thing standing in the way.
        let tmp = tempfile::tempdir().unwrap();
        write_plugin(tmp.path(), "evil\nplugin", "evil\nplugin");

        let found = scan_dir(tmp.path()).unwrap();
        assert!(found.is_empty(), "got: {found:?}");
    }

    #[test]
    fn a_dotted_directory_name_is_still_a_plain_name() {
        // Guarding the case above must not cost legitimate names: `..weird` is one
        // ordinary path component, not traversal.
        let tmp = tempfile::tempdir().unwrap();
        write_plugin(tmp.path(), "..weird", "..weird");

        let found = scan_dir(tmp.path()).unwrap();
        assert_eq!(found.len(), 1);
    }

    #[test]
    fn scan_skips_directories_without_a_manifest_and_keeps_going() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("not-a-plugin")).unwrap();
        write_plugin(tmp.path(), "evil", "trusted-plugin");
        write_plugin(tmp.path(), "real", "real");

        // One bad entry must not cost the user their working plugins.
        let found = scan_dir(tmp.path()).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "real");
    }

    // ── grants are written atomically ──────────────────────────────────────

    #[test]
    fn grants_save_leaves_no_temp_file_behind() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("plugin-grants.json");

        let mut grants = HashMap::new();
        grants.insert(
            "my-plugin".to_string(),
            PluginGrant {
                permissions: vec!["workspace:read".to_string()],
                network: vec![],
                manifest_hash: "abc123".to_string(),
            },
        );

        write_grants(&path, &grants).unwrap();

        let back: HashMap<String, PluginGrant> =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(back["my-plugin"].manifest_hash, "abc123");
        assert!(
            !path.with_extension("json.tmp").exists(),
            "the temp file must not survive the rename"
        );
    }

    #[test]
    fn grants_save_creates_the_config_directory() {
        // First run on a clean machine: the julide config dir does not exist yet.
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("nested").join("julide").join("grants.json");

        write_grants(&path, &HashMap::new()).unwrap();
        assert!(path.exists());
    }

    // ── grants ─────────────────────────────────────────────────────────────

    #[test]
    fn grant_serde_round_trip() {
        let mut grants = HashMap::new();
        grants.insert(
            "my-plugin".to_string(),
            PluginGrant {
                permissions: vec!["workspace:read".to_string(), "julia:run".to_string()],
                network: vec![],
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
    fn manifest_without_api_version_reads_as_the_pre_sandbox_api() {
        // Every plugin written before the sandbox omits the field. Defaulting to the
        // current generation would load it into a world where its panel API silently
        // does nothing; the frontend refuses v1 with a migration message instead.
        let json = r#"{
            "name": "old",
            "version": "1.0.0",
            "displayName": "Old",
            "main": "index.js"
        }"#;
        let manifest: PluginManifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.api_version, 1);
        assert!(manifest.network.is_empty());
    }

    #[test]
    fn manifest_network_round_trips_as_camel_case() {
        let json = r#"{
            "name": "n",
            "version": "1.0.0",
            "displayName": "N",
            "main": "index.js",
            "apiVersion": 2,
            "network": ["https://api.github.com"]
        }"#;
        let manifest: PluginManifest = serde_json::from_str(json).unwrap();
        assert_eq!(manifest.api_version, 2);
        assert_eq!(manifest.network, vec!["https://api.github.com"]);

        let back = serde_json::to_string(&manifest).unwrap();
        assert!(back.contains("apiVersion"), "got: {back}");
    }

    #[test]
    fn a_grant_written_before_the_network_field_existed_still_loads() {
        // Otherwise adding the field would silently reset every approval the user has
        // ever made, and they would be re-prompted for everything with no explanation.
        let json = r#"{"my-plugin":{"permissions":["workspace:read"],"manifestHash":"abc"}}"#;
        let grants: HashMap<String, PluginGrant> = serde_json::from_str(json).unwrap();
        assert_eq!(grants["my-plugin"].permissions, vec!["workspace:read"]);
        assert!(grants["my-plugin"].network.is_empty());
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
