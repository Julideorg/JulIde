//! Helpers for deciding whether an in-app update can actually be applied.
//!
//! `tauri-plugin-updater` cannot replace a `.deb` or `.rpm` install — on Linux it
//! only supports AppImage, because that is the only format where the running binary
//! is a single file the app may rewrite. Packages installed through apt/dnf are owned
//! by the system package manager and must be updated through it.
//!
//! Rather than hiding the update entirely for those users, julIDE still *checks* and
//! tells them a new version exists; it just points them at the download page instead
//! of offering a button that would fail.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstallCapability {
    /// True when the running bundle can replace itself in place.
    pub can_self_install: bool,
    /// Short, user-facing reason when it cannot — e.g. "installed via .deb".
    pub reason: Option<String>,
    /// Best guess at the install format, for diagnostics.
    pub format: String,
}

/// Determine whether the currently running bundle supports in-place update.
#[tauri::command]
pub fn updater_install_capability() -> InstallCapability {
    detect_capability()
}

#[cfg(target_os = "linux")]
fn detect_capability() -> InstallCapability {
    // AppImage sets APPIMAGE to the path of the running image; the updater relies on
    // exactly this to know what to replace.
    if std::env::var_os("APPIMAGE").is_some() {
        InstallCapability {
            can_self_install: true,
            reason: None,
            format: "appimage".to_string(),
        }
    } else {
        InstallCapability {
            can_self_install: false,
            reason: Some(
                "julIDE was installed from a system package (.deb/.rpm) or run from source. \
                 Update it with your package manager, or download the AppImage for in-app updates."
                    .to_string(),
            ),
            format: "system-package".to_string(),
        }
    }
}

#[cfg(target_os = "macos")]
fn detect_capability() -> InstallCapability {
    InstallCapability {
        can_self_install: true,
        reason: None,
        format: "app-bundle".to_string(),
    }
}

#[cfg(target_os = "windows")]
fn detect_capability() -> InstallCapability {
    InstallCapability {
        can_self_install: true,
        reason: None,
        format: "installer".to_string(),
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn detect_capability() -> InstallCapability {
    InstallCapability {
        can_self_install: false,
        reason: Some("In-app updates are not supported on this platform.".to_string()),
        format: "unknown".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_is_serialised_as_camel_case() {
        // The TS side reads `canSelfInstall`.
        let json = serde_json::to_string(&InstallCapability {
            can_self_install: true,
            reason: None,
            format: "appimage".to_string(),
        })
        .unwrap();
        assert!(json.contains("canSelfInstall"), "got: {json}");
    }

    #[test]
    fn detect_returns_a_format_string() {
        let cap = detect_capability();
        assert!(!cap.format.is_empty());
        // Whenever self-install is unavailable the user must be told why, otherwise
        // the UI has nothing to show them.
        if !cap.can_self_install {
            assert!(cap.reason.is_some(), "missing reason for {:?}", cap.format);
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_without_appimage_env_cannot_self_install() {
        // The test binary is not an AppImage, so this exercises the deb/rpm path.
        if std::env::var_os("APPIMAGE").is_none() {
            let cap = detect_capability();
            assert!(!cap.can_self_install);
            assert_eq!(cap.format, "system-package");
        }
    }
}
