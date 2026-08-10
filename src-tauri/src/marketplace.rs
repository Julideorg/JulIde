//! Installing plugins from the julIDE plugin registry.
//!
//! Every network request here happens in Rust, never in the webview. Widening the
//! webview's `connect-src` to reach the registry would widen it for every plugin sharing
//! that realm — a bad trade for a feature that does not need it. Icons need no CSP change
//! either: `img-src` already permits `data:`.
//!
//! ## What is trusted, and why
//!
//! The registry index is **signed**, not merely served over TLS. Without that, whoever
//! controls the host controls the sha256 this module verifies against, and the digest
//! would only prove "I downloaded what the host meant to send". The signing key is
//! deliberately *not* the Tauri updater key: sharing them would make a registry-signing
//! compromise an app-update compromise, which is a far larger blast radius than this
//! feature warrants.
//!
//! The revocation feed fails **open** on a fetch error — an IDE that will not load
//! plugins on a plane is worse than the exposure window — and **closed** on a signature
//! failure, where the document is rejected and the last verified copy kept.
//!
//! These commands are deliberately absent from `COMMAND_PERMISSIONS`, exactly as the
//! `plugin_*` commands are. A plugin that can install plugins is privilege escalation
//! with no legitimate use.

use crate::http::{assert_https, read_capped, HTTP};
use crate::plugins::validate_plugin_name;
use crate::sync::LockRecover;
use flate2::read::GzDecoder;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tar::{Archive, EntryType};

/// Where the registry lives.
///
/// A constant, not a setting. Making it configurable would let a compromised
/// `settings.json` — or a plugin holding `settings:write` — repoint the registry, and the
/// pinned key would then be verifying a document from an attacker-chosen host. The
/// trade is that self-hosted registries are unsupported.
const REGISTRY_BASE: &str =
    "https://raw.githubusercontent.com/Julideorg/julide-plugin-registry/master/registry";

/// The pinned registry signing key.
///
/// A separate file so a key change is a one-file diff in review rather than something
/// buried in a source edit. julIDE accepts a *set* of keys: retrofitting a set into a
/// single pinned key requires a release, which is exactly what cannot be done during an
/// incident.
const REGISTRY_PUBKEYS: &str = include_str!("../registry-keys.pub");

const INDEX_TIMEOUT: Duration = Duration::from_secs(30);
const TARBALL_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_INDEX_BYTES: usize = 8 * 1024 * 1024;
const MAX_SIGNATURE_BYTES: usize = 4 * 1024;
const MAX_TARBALL_BYTES: usize = 32 * 1024 * 1024;
/// Ceiling on what a bundle may expand to. A gzip bomb hits this instead of the disk.
const MAX_DECOMPRESSED_BYTES: u64 = 128 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 512;
const MAX_PATH_DEPTH: usize = 32;

// ─── Wire types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryVersion {
    pub version: String,
    pub tarball: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub manifest_hash: String,
    pub api_version: u32,
    pub permissions: Vec<String>,
    pub network: Vec<String>,
    pub engines: RegistryEngines,
    pub published_at: String,
    #[serde(default)]
    pub yanked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEngines {
    pub julide: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryCapability {
    pub headline: String,
    pub capabilities: Vec<String>,
    pub additional_count: u32,
    pub tier: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEntry {
    pub name: String,
    pub display_name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub author: String,
    pub repository: String,
    #[serde(default)]
    pub homepage: Option<String>,
    pub license: String,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub keywords: Vec<String>,
    pub latest: Option<RegistryVersion>,
    pub capability: RegistryCapability,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryIndex {
    pub schema_version: u32,
    pub generated_at: String,
    #[serde(default)]
    pub paused: bool,
    pub count: u32,
    pub plugins: Vec<RegistryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Revocation {
    pub plugin: String,
    pub versions: String,
    pub action: String,
    pub severity: String,
    pub reason: String,
    #[serde(default)]
    pub advisory: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevocationFeed {
    pub schema_version: u32,
    pub serial: u64,
    pub generated_at: String,
    pub entries: Vec<Revocation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub name: String,
    pub version: String,
    pub manifest: crate::plugins::PluginManifest,
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

async fn get_capped(
    url: &str,
    cap: usize,
    timeout: Duration,
    what: &str,
) -> Result<Vec<u8>, String> {
    assert_https(url)?;
    let response = HTTP
        .get(url)
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| format!("{what}: {e}"))?;
    read_capped(
        response,
        cap,
        what,
        // 404 on raw.githubusercontent.com means the file is not at that path on that
        // branch — which for a registry that has not been published yet is the normal
        // state, not a fault.
        Some("The plugin registry may not be published yet."),
    )
    .await
}

// ─── Signature verification ─────────────────────────────────────────────────

/// Verify a detached minisign signature against any pinned key.
///
/// A *set* of keys, so a rotation can overlap: a release can add the new key before the
/// old signature stops being published. Rejecting for the honest reason matters here —
/// "signed by an unpinned key" and "the signature is corrupt" call for different
/// responses during an incident.
fn verify_signature(content: &[u8], signature: &str) -> Result<(), String> {
    let sig = minisign_verify::Signature::decode(signature)
        .map_err(|e| format!("the signature could not be parsed: {e}"))?;

    let mut last_error = String::from("no pinned key matched");
    for line in REGISTRY_PUBKEYS.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("untrusted comment:") {
            continue;
        }
        let Ok(key) = minisign_verify::PublicKey::from_base64(line) else {
            continue;
        };
        // `allow_legacy = true`: the registry signs in legacy Ed mode, because prehashed
        // minisign uses BLAKE2b and the registry's own CI verifies in TypeScript over
        // WebCrypto, which has no BLAKE2b.
        match key.verify(content, &sig, true) {
            Ok(()) => return Ok(()),
            Err(e) => last_error = e.to_string(),
        }
    }
    Err(format!("signature verification failed: {last_error}"))
}

// ─── Digests and paths ──────────────────────────────────────────────────────

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Every component of an archive member must satisfy the plugin-name rule.
///
/// Reusing `validate_plugin_name` rather than writing a second traversal check: one
/// implementation cannot drift from itself. It rejects `..`, absolute paths, Windows
/// device prefixes and control characters in one place.
fn validate_archive_path(path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty() {
        return Err("archive contains an empty member path".into());
    }
    if path.components().count() > MAX_PATH_DEPTH {
        return Err(format!(
            "archive member is nested deeper than {MAX_PATH_DEPTH} levels"
        ));
    }
    for component in path.components() {
        match component {
            Component::Normal(name) => {
                let s = name
                    .to_str()
                    .ok_or_else(|| "archive contains a non-UTF-8 member name".to_string())?;
                validate_plugin_name(s).map_err(|e| {
                    format!(
                        "archive member escapes the plugin directory ({}): {e}",
                        path.display()
                    )
                })?;
            }
            _ => {
                return Err(format!(
                    "archive member escapes the plugin directory: {}",
                    path.display()
                ))
            }
        }
    }
    Ok(())
}

/// Extract a `.tar.gz` into `dest`, refusing anything that is not a plain file or dir.
///
/// The entry-type allowlist is the important part. A symlink member is the classic
/// escape: member one is a symlink `x -> /home/you/.ssh`, member two is a regular file
/// `x/authorized_keys`, and a naive extractor writes *through* the link. Hardlinks do the
/// same to an existing file; devices and fifos have no business in a plugin bundle.
fn extract_tar_gz(bytes: &[u8], dest: &Path) -> Result<(), String> {
    let decoder = GzDecoder::new(std::io::Cursor::new(bytes));
    let mut archive = Archive::new(decoder.take(MAX_DECOMPRESSED_BYTES));
    archive.set_preserve_permissions(false);
    archive.set_preserve_mtime(false);
    archive.set_unpack_xattrs(false);
    archive.set_overwrite(false);

    let mut count = 0usize;
    for entry in archive
        .entries()
        .map_err(|e| format!("unreadable archive: {e}"))?
    {
        let mut entry = entry.map_err(|e| format!("unreadable archive member: {e}"))?;
        count += 1;
        if count > MAX_ARCHIVE_ENTRIES {
            return Err(format!(
                "archive has more than {MAX_ARCHIVE_ENTRIES} members"
            ));
        }

        match entry.header().entry_type() {
            EntryType::Regular | EntryType::Directory => {}
            other => {
                return Err(format!(
                    "archive contains an unsupported member type ({other:?}); \
                     only plain files and directories are extracted"
                ))
            }
        }

        let path = entry
            .path()
            .map_err(|e| format!("unreadable member path: {e}"))?
            .into_owned();
        validate_archive_path(&path)?;

        // tar-rs's own confinement, kept as a second layer behind our own check.
        entry
            .unpack_in(dest)
            .map_err(|e| format!("could not extract {}: {e}", path.display()))?;
    }

    normalise_modes(dest)?;
    Ok(())
}

/// Drop any setuid, setgid or execute bit the archive tried to carry.
///
/// A plugin is JavaScript. Nothing in one needs to be executable.
#[cfg(unix)]
fn normalise_modes(root: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    for entry in walkdir::WalkDir::new(root).into_iter().flatten() {
        let mode = if entry.file_type().is_dir() {
            0o755
        } else {
            0o644
        };
        std::fs::set_permissions(entry.path(), std::fs::Permissions::from_mode(mode))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn normalise_modes(_root: &Path) -> Result<(), String> {
    Ok(())
}

// ─── Paths ──────────────────────────────────────────────────────────────────

fn plugins_root() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".julide").join("plugins")
}

/// Staging lives under `~/.julide/`, never in the system temp directory.
///
/// `/tmp` is a separate filesystem on most Linux setups, and `fs::rename` across
/// filesystems fails with `EXDEV`. That is the single most common way an "atomic
/// install" ships broken.
fn staging_root() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".julide").join(".staging")
}

fn cache_root() -> PathBuf {
    let cache = dirs::cache_dir().unwrap_or_else(|| PathBuf::from("."));
    cache.join("julide").join("marketplace")
}

// ─── Install serialisation ──────────────────────────────────────────────────

static IN_FLIGHT: Lazy<Arc<Mutex<HashSet<String>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashSet::new())));

/// Marks a plugin as being installed and clears it on drop.
///
/// RAII rather than a manual remove, so an early return or a `?` cannot leave a stuck
/// entry that blocks every later attempt.
struct InstallGuard(String);

impl InstallGuard {
    fn acquire(name: &str) -> Result<Self, String> {
        let mut set = IN_FLIGHT.lock_recover();
        if !set.insert(name.to_string()) {
            return Err(format!("{name} is already being installed"));
        }
        Ok(InstallGuard(name.to_string()))
    }
}

impl Drop for InstallGuard {
    fn drop(&mut self) {
        IN_FLIGHT.lock_recover().remove(&self.0);
    }
}

// ─── Commands ───────────────────────────────────────────────────────────────

/// Fetch and verify the registry index.
///
/// The signature is checked before the JSON is parsed: an unverified document is not
/// something to deserialise, let alone act on.
#[tauri::command]
pub async fn marketplace_fetch_index(force_refresh: bool) -> Result<RegistryIndex, String> {
    let cached = cache_root().join("index.json");
    if !force_refresh {
        if let Ok(bytes) = std::fs::read(&cached) {
            if let Ok(index) = serde_json::from_slice::<RegistryIndex>(&bytes) {
                return Ok(index);
            }
        }
    }

    let index_url = format!("{REGISTRY_BASE}/index.json");
    let sig_url = format!("{index_url}.minisig");

    let body = get_capped(
        &index_url,
        MAX_INDEX_BYTES,
        INDEX_TIMEOUT,
        "the registry index",
    )
    .await?;
    let signature = get_capped(
        &sig_url,
        MAX_SIGNATURE_BYTES,
        INDEX_TIMEOUT,
        "the registry index signature",
    )
    .await?;
    let signature =
        String::from_utf8(signature).map_err(|_| "the signature is not text".to_string())?;

    verify_signature(&body, &signature)?;

    let index: RegistryIndex = serde_json::from_slice(&body)
        .map_err(|e| format!("the registry index is malformed: {e}"))?;

    std::fs::create_dir_all(cache_root()).ok();
    std::fs::write(&cached, &body).ok();

    Ok(index)
}

/// Fetch the signed revocation feed.
///
/// Returns `Ok(None)` when there is nothing trustworthy to report — a fetch failure, or
/// no cached copy. The caller treats that as "no revocations" and carries on, because an
/// IDE that refuses to load plugins offline is worse than the exposure window. A
/// *signature* failure is an error, so the caller can keep its last verified copy and say
/// something rather than silently accepting a forgery.
#[tauri::command]
pub async fn marketplace_fetch_revocations(
    force_refresh: bool,
) -> Result<Option<RevocationFeed>, String> {
    let cached = cache_root().join("revocations.json");
    if !force_refresh {
        if let Ok(bytes) = std::fs::read(&cached) {
            if let Ok(feed) = serde_json::from_slice::<RevocationFeed>(&bytes) {
                return Ok(Some(feed));
            }
        }
    }

    let feed_url = format!("{REGISTRY_BASE}/revocations.json");
    let sig_url = format!("{feed_url}.minisig");

    let body = match get_capped(
        &feed_url,
        MAX_INDEX_BYTES,
        INDEX_TIMEOUT,
        "the advisory feed",
    )
    .await
    {
        Ok(b) => b,
        // Fail open: fall back to whatever was last verified, or to nothing.
        Err(_) => {
            return Ok(std::fs::read(&cached)
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok()))
        }
    };
    let signature = match get_capped(
        &sig_url,
        MAX_SIGNATURE_BYTES,
        INDEX_TIMEOUT,
        "the advisory feed signature",
    )
    .await
    {
        Ok(s) => String::from_utf8(s).map_err(|_| "the signature is not text".to_string())?,
        Err(_) => {
            return Ok(std::fs::read(&cached)
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok()))
        }
    };

    // Fail closed on the content: reject the document, keep the last verified one.
    verify_signature(&body, &signature)?;

    let feed: RevocationFeed = serde_json::from_slice(&body)
        .map_err(|e| format!("the advisory feed is malformed: {e}"))?;

    // Anti-rollback. Replaying an older, correctly signed feed is how a downgrade undoes
    // a revocation without ever failing a signature check.
    if let Ok(previous) = std::fs::read(&cached) {
        if let Ok(old) = serde_json::from_slice::<RevocationFeed>(&previous) {
            if feed.serial < old.serial {
                return Err(format!(
                    "the advisory feed went backwards (serial {} after {}); keeping the previous one",
                    feed.serial, old.serial
                ));
            }
        }
    }

    std::fs::create_dir_all(cache_root()).ok();
    std::fs::write(&cached, &body).ok();
    Ok(Some(feed))
}

/// Download, verify and install one version.
#[tauri::command]
pub async fn marketplace_install(name: String, version: String) -> Result<InstallResult, String> {
    validate_plugin_name(&name)?;
    let _guard = InstallGuard::acquire(&name)?;

    let index = marketplace_fetch_index(false).await?;
    if index.paused {
        return Err(
            "The plugin registry has paused installs. Try again later, or check the registry for an announcement."
                .into(),
        );
    }

    let entry = index
        .plugins
        .iter()
        .find(|p| p.name == name)
        .ok_or_else(|| format!("{name} is not in the registry"))?;
    let target = entry
        .latest
        .as_ref()
        .filter(|v| v.version == version)
        .ok_or_else(|| format!("{name} {version} is not the version the registry offers"))?;

    let bytes = get_capped(
        &target.tarball,
        MAX_TARBALL_BYTES,
        TARBALL_TIMEOUT,
        &format!("{name} {version}"),
    )
    .await?;

    // Verified before anything is written to disk. The digest comes from the signed
    // index, which is what makes it mean something.
    let digest = sha256_hex(&bytes);
    if digest != target.sha256 {
        return Err(format!(
            "{name} {version} does not match its published digest. Expected {}, got {digest}. \
             The download was corrupted or the artifact was replaced at its URL.",
            target.sha256
        ));
    }

    install_verified_bytes(&name, &version, &bytes)
}

/// The disk half of an install, split out so it is testable without the network.
fn install_verified_bytes(
    name: &str,
    version: &str,
    bytes: &[u8],
) -> Result<InstallResult, String> {
    let staging = staging_root().join(format!("{name}-{}", uuid::Uuid::new_v4().simple()));
    let backup = staging.with_extension("old");
    let target = plugins_root().join(name);

    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let cleanup = |dir: &Path| {
        let _ = std::fs::remove_dir_all(dir);
    };

    if let Err(e) = extract_tar_gz(bytes, &staging) {
        cleanup(&staging);
        return Err(e);
    }

    // Identity binding. Without it, installing `pretty-printer` could unpack a manifest
    // declaring `name: "git-helper"` — and since grants are keyed by name and the
    // fingerprint covers name+version+main+permissions, the archive would inherit that
    // plugin's approval with no prompt. This is what makes "the user consented to
    // install X" mean "X is what runs".
    let manifest = match read_manifest(&staging, name, version) {
        Ok(m) => m,
        Err(e) => {
            cleanup(&staging);
            return Err(e);
        }
    };

    if let Err(e) = swap_in_place(&staging, &target, &backup) {
        cleanup(&staging);
        return Err(e);
    }
    cleanup(&backup);

    Ok(InstallResult {
        name: name.to_string(),
        version: version.to_string(),
        manifest,
    })
}

fn read_manifest(
    staging: &Path,
    name: &str,
    version: &str,
) -> Result<crate::plugins::PluginManifest, String> {
    let text = std::fs::read_to_string(staging.join("plugin.json"))
        .map_err(|_| "the archive has no plugin.json at its root".to_string())?;
    let manifest: crate::plugins::PluginManifest =
        serde_json::from_str(&text).map_err(|e| format!("plugin.json is malformed: {e}"))?;

    if manifest.name != name {
        return Err(format!(
            "the archive declares plugin \"{}\" but {name} was requested",
            manifest.name
        ));
    }
    if manifest.version != version {
        return Err(format!(
            "the archive declares version {} but {version} was requested",
            manifest.version
        ));
    }

    let entry = staging.join(&manifest.main);
    let canonical_staging = staging.canonicalize().map_err(|e| e.to_string())?;
    let canonical_entry = entry
        .canonicalize()
        .map_err(|_| format!("the entry point {} is missing", manifest.main))?;
    if !canonical_entry.starts_with(&canonical_staging) {
        return Err("the manifest points its entry outside the plugin directory".into());
    }

    Ok(manifest)
}

/// Move `staging` into place, restoring the previous copy if the move fails.
///
/// Split out so the rollback branch is directly testable.
fn swap_in_place(staging: &Path, target: &Path, backup: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let had_previous = target.exists();
    if had_previous {
        std::fs::rename(target, backup)
            .map_err(|e| format!("could not set the existing install aside: {e}"))?;
    }

    if let Err(e) = std::fs::rename(staging, target) {
        if had_previous {
            // Put the working copy back rather than leaving the user with nothing.
            let _ = std::fs::rename(backup, target);
        }
        return Err(format!("could not move the new version into place: {e}"));
    }
    Ok(())
}

#[tauri::command]
pub fn marketplace_uninstall(name: String) -> Result<(), String> {
    validate_plugin_name(&name)?;
    let dir = plugins_root().join(&name);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }

    // Drop the grant too. Without this, uninstalling and reinstalling the same version
    // reproduces the same fingerprint and silently re-inherits the old approval — so
    // "uninstall" has to mean "and forget what I allowed it".
    let mut grants = crate::plugins::plugin_grants_load();
    if grants.remove(&name).is_some() {
        crate::plugins::plugin_grants_save(grants)?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    pub name: String,
    pub installed_version: String,
    pub available_version: String,
    /// Permissions the new version asks for that the installed one did not.
    pub permissions_added: Vec<String>,
}

#[tauri::command]
pub async fn marketplace_check_updates() -> Result<Vec<AvailableUpdate>, String> {
    let index = marketplace_fetch_index(false).await?;
    let installed = crate::plugins::plugin_scan()?;
    let mut updates = Vec::new();

    for plugin in installed {
        let Some(entry) = index.plugins.iter().find(|p| p.name == plugin.name) else {
            continue;
        };
        let Some(latest) = entry.latest.as_ref() else {
            continue;
        };

        // Ordered comparison, not string inequality: "0.10.0" sorts before "0.9.0"
        // lexically, which is how a downgrade gets offered as an update.
        let (Ok(have), Ok(want)) = (
            semver::Version::parse(&plugin.version),
            semver::Version::parse(&latest.version),
        ) else {
            continue;
        };
        if want <= have {
            continue;
        }

        let existing: HashSet<&String> = plugin.permissions.iter().collect();
        updates.push(AvailableUpdate {
            name: plugin.name.clone(),
            installed_version: plugin.version.clone(),
            available_version: latest.version.clone(),
            permissions_added: latest
                .permissions
                .iter()
                .filter(|p| !existing.contains(p))
                .cloned()
                .collect(),
        });
    }

    Ok(updates)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_known_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn archive_paths_may_not_escape() {
        assert!(validate_archive_path(Path::new("dist/index.js")).is_ok());
        assert!(validate_archive_path(Path::new("plugin.json")).is_ok());

        for bad in [
            "../escape.js",
            "../../etc/passwd",
            "/etc/passwd",
            "dist/../../x",
            "",
        ] {
            assert!(validate_archive_path(Path::new(bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn archive_paths_may_not_carry_control_characters() {
        // The plugin-name rule catches these, which is the reason for reusing it rather
        // than writing a second traversal check that would have to remember to.
        assert!(validate_archive_path(Path::new("bad\nname.js")).is_err());
    }

    #[test]
    fn archive_paths_may_not_be_deeply_nested() {
        let deep: String = (0..40).map(|_| "a/").collect::<String>() + "x.js";
        assert!(validate_archive_path(Path::new(&deep)).is_err());
    }

    #[test]
    fn an_unsigned_index_is_refused() {
        assert!(verify_signature(b"{}", "not a signature").is_err());
    }

    // ── cross-language signature check ─────────────────────────────────────
    //
    // The registry signs in TypeScript over WebCrypto; julIDE verifies in Rust with
    // minisign-verify. Two implementations of one format, in two languages, with no
    // shared code — exactly the kind of assumption that holds until the day it does
    // not, and whose failure mode is "the kill switch silently stops working".
    //
    // These fixtures are the real signed feed from the registry repository, verified
    // against the real pinned key.

    const FIXTURE_FEED: &[u8] = include_bytes!("../tests/fixtures/revocations.json");
    const FIXTURE_SIG: &str = include_str!("../tests/fixtures/revocations.json.minisig");

    #[test]
    fn a_feed_signed_by_the_registry_verifies_here() {
        verify_signature(FIXTURE_FEED, FIXTURE_SIG)
            .expect("the pinned key should verify the registry's own signature");
    }

    #[test]
    fn one_flipped_byte_in_the_feed_fails() {
        let mut tampered = FIXTURE_FEED.to_vec();
        // Flip a byte inside the JSON body rather than in trailing whitespace.
        let i = tampered.len() / 2;
        tampered[i] ^= 0x01;
        assert!(verify_signature(&tampered, FIXTURE_SIG).is_err());
    }

    const FIXTURE_INDEX: &[u8] = include_bytes!("../tests/fixtures/index.json");
    const FIXTURE_INDEX_SIG: &str = include_str!("../tests/fixtures/index.json.minisig");

    #[test]
    fn an_index_signed_by_the_registry_verifies_here() {
        // The index carries the sha256 of every artifact this module verifies a download
        // against, so an index julIDE cannot verify means no plugin can be installed at
        // all. Worth pinning against the registry's real output rather than assuming the
        // two implementations of minisign agree.
        verify_signature(FIXTURE_INDEX, FIXTURE_INDEX_SIG)
            .expect("the pinned key should verify the registry's own index signature");
    }

    #[test]
    fn a_substituted_index_fails() {
        // The attack signing exists to stop: serving a different index, with different
        // digests, from a host that otherwise looks legitimate.
        let substituted =
            br#"{"schemaVersion":1,"generatedAt":"x","paused":false,"count":0,"plugins":[]}"#;
        assert!(verify_signature(substituted, FIXTURE_INDEX_SIG).is_err());
    }

    #[test]
    fn an_edited_trusted_comment_fails() {
        // The serial lives in the trusted comment, and the global signature is what
        // makes it trustworthy — this is the anti-rollback defence.
        let tampered = FIXTURE_SIG.replace("serial=1", "serial=9");
        assert!(verify_signature(FIXTURE_FEED, &tampered).is_err());
    }

    // ── swap_in_place ──────────────────────────────────────────────────────

    fn write_tree(dir: &Path, marker: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("plugin.json"), marker).unwrap();
    }

    #[test]
    fn swap_replaces_an_existing_install() {
        let tmp = tempfile::tempdir().unwrap();
        let staging = tmp.path().join("staging");
        let target = tmp.path().join("target");
        let backup = tmp.path().join("backup");
        write_tree(&staging, "new");
        write_tree(&target, "old");

        swap_in_place(&staging, &target, &backup).unwrap();

        assert_eq!(
            std::fs::read_to_string(target.join("plugin.json")).unwrap(),
            "new"
        );
        assert!(!staging.exists());
    }

    #[test]
    fn swap_works_on_a_first_install() {
        let tmp = tempfile::tempdir().unwrap();
        let staging = tmp.path().join("staging");
        let target = tmp.path().join("target");
        write_tree(&staging, "new");

        swap_in_place(&staging, &target, &tmp.path().join("backup")).unwrap();
        assert_eq!(
            std::fs::read_to_string(target.join("plugin.json")).unwrap(),
            "new"
        );
    }

    #[test]
    fn a_failed_swap_puts_the_working_copy_back() {
        // The case that matters: a half-finished install must never leave the user
        // without the plugin they had.
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("target");
        let backup = tmp.path().join("backup");
        write_tree(&target, "old");

        // Staging does not exist, so the second rename fails.
        let missing = tmp.path().join("missing-staging");
        assert!(swap_in_place(&missing, &target, &backup).is_err());

        assert_eq!(
            std::fs::read_to_string(target.join("plugin.json")).unwrap(),
            "old"
        );
    }

    // ── extraction guards ──────────────────────────────────────────────────

    /// Build a `.tar.gz` in memory, so the guards are tested against real archives.
    fn tar_gz(build: impl FnOnce(&mut tar::Builder<Vec<u8>>)) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        build(&mut builder);
        let tar = builder.into_inner().unwrap();

        use flate2::write::GzEncoder;
        use std::io::Write;
        let mut encoder = GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&tar).unwrap();
        encoder.finish().unwrap()
    }

    fn add_file(builder: &mut tar::Builder<Vec<u8>>, path: &str, contents: &[u8]) {
        let mut header = tar::Header::new_gnu();
        header.set_size(contents.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append_data(&mut header, path, contents).unwrap();
    }

    fn add_special(builder: &mut tar::Builder<Vec<u8>>, path: &str, link: &str, kind: EntryType) {
        let mut header = tar::Header::new_gnu();
        header.set_size(0);
        header.set_mode(0o777);
        header.set_entry_type(kind);
        builder.append_link(&mut header, path, link).unwrap();
    }

    #[test]
    fn a_plain_archive_extracts() {
        let tmp = tempfile::tempdir().unwrap();
        let bytes = tar_gz(|b| {
            add_file(b, "plugin.json", br#"{"name":"p"}"#);
            add_file(b, "dist/index.js", b"window.julide = {};");
        });

        extract_tar_gz(&bytes, tmp.path()).unwrap();
        assert!(tmp.path().join("dist/index.js").exists());
    }

    #[test]
    fn a_symlink_member_is_refused() {
        // The classic escape: member one is a symlink pointing outside, member two is a
        // regular file "inside" it, and a naive extractor writes *through* the link.
        let tmp = tempfile::tempdir().unwrap();
        let bytes = tar_gz(|b| {
            add_special(b, "escape", "/tmp", EntryType::Symlink);
            add_file(b, "escape/pwned.txt", b"x");
        });

        let err = extract_tar_gz(&bytes, tmp.path()).unwrap_err();
        assert!(err.contains("unsupported member type"), "got: {err}");
    }

    #[test]
    fn a_hardlink_member_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let bytes = tar_gz(|b| add_special(b, "link", "plugin.json", EntryType::Link));
        assert!(extract_tar_gz(&bytes, tmp.path()).is_err());
    }

    /// Append a member whose path `tar::Builder` would refuse to write.
    ///
    /// `set_path` rejects `..`, so a hostile archive cannot be built with the normal
    /// API — but nothing stops an attacker's tar from containing one, which is exactly
    /// what the guard is for. The name is written into the raw header instead.
    fn add_raw_named(builder: &mut tar::Builder<Vec<u8>>, path: &str, contents: &[u8]) {
        let mut header = tar::Header::new_gnu();
        header.set_size(contents.len() as u64);
        header.set_mode(0o644);
        header.set_entry_type(EntryType::Regular);
        {
            let name = &mut header.as_old_mut().name;
            name.fill(0);
            name[..path.len()].copy_from_slice(path.as_bytes());
        }
        header.set_cksum();
        builder.append(&header, contents).unwrap();
    }

    #[test]
    fn a_traversing_member_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let dest = outside.join("dest");
        std::fs::create_dir_all(&dest).unwrap();

        let bytes = tar_gz(|b| add_raw_named(b, "../escaped.js", b"x"));

        let err = extract_tar_gz(&bytes, &dest).unwrap_err();
        assert!(err.contains("escapes the plugin directory"), "got: {err}");
        assert!(!outside.join("escaped.js").exists(), "the file escaped");
    }

    #[test]
    fn an_absolute_member_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let bytes = tar_gz(|b| add_raw_named(b, "/etc/julide-pwned", b"x"));

        let err = extract_tar_gz(&bytes, tmp.path()).unwrap_err();
        assert!(err.contains("escapes the plugin directory"), "got: {err}");
    }

    #[test]
    fn too_many_members_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let bytes = tar_gz(|b| {
            for i in 0..(MAX_ARCHIVE_ENTRIES + 10) {
                add_file(b, &format!("f{i}.js"), b"x");
            }
        });
        let err = extract_tar_gz(&bytes, tmp.path()).unwrap_err();
        assert!(err.contains("more than"), "got: {err}");
    }

    #[test]
    fn garbage_is_not_mistaken_for_an_archive() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(extract_tar_gz(b"not a gzip stream at all", tmp.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn the_execute_bit_does_not_survive_extraction() {
        // A plugin is JavaScript. Nothing in one needs to be executable, and a setuid
        // bit smuggled through an archive is not something to preserve faithfully.
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let bytes = tar_gz(|b| {
            let contents = b"#!/bin/sh\necho pwned";
            let mut header = tar::Header::new_gnu();
            header.set_size(contents.len() as u64);
            header.set_mode(0o4755);
            header.set_cksum();
            b.append_data(&mut header, "run.sh", &contents[..]).unwrap();
        });

        extract_tar_gz(&bytes, tmp.path()).unwrap();
        let mode = std::fs::metadata(tmp.path().join("run.sh"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o7777, 0o644, "mode was {:o}", mode & 0o7777);
    }

    // ── manifest identity ──────────────────────────────────────────────────

    fn staged_manifest(dir: &Path, json: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("plugin.json"), json).unwrap();
        std::fs::write(dir.join("index.js"), "window.julide = {};").unwrap();
    }

    #[test]
    fn a_manifest_claiming_another_plugin_is_refused() {
        // Grants are keyed by name, so an archive that reproduces another plugin's
        // identity would inherit its approval with no prompt.
        let tmp = tempfile::tempdir().unwrap();
        staged_manifest(
            tmp.path(),
            r#"{"name":"git-helper","version":"1.0.0","displayName":"X","main":"index.js"}"#,
        );
        let err = read_manifest(tmp.path(), "pretty-printer", "1.0.0").unwrap_err();
        assert!(err.contains("git-helper"), "got: {err}");
    }

    #[test]
    fn a_version_mismatch_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        staged_manifest(
            tmp.path(),
            r#"{"name":"p","version":"9.9.9","displayName":"X","main":"index.js"}"#,
        );
        assert!(read_manifest(tmp.path(), "p", "1.0.0").is_err());
    }

    #[test]
    fn an_entry_point_outside_the_directory_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        staged_manifest(
            tmp.path(),
            r#"{"name":"p","version":"1.0.0","displayName":"X","main":"../../../etc/passwd"}"#,
        );
        assert!(read_manifest(tmp.path(), "p", "1.0.0").is_err());
    }

    #[test]
    fn a_matching_manifest_is_accepted() {
        let tmp = tempfile::tempdir().unwrap();
        staged_manifest(
            tmp.path(),
            r#"{"name":"p","version":"1.0.0","displayName":"X","main":"index.js","apiVersion":2}"#,
        );
        let m = read_manifest(tmp.path(), "p", "1.0.0").unwrap();
        assert_eq!(m.api_version, 2);
    }
}
