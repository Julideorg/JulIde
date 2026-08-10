//! Helpers for deciding whether an in-app update can actually be applied.
//!
//! `tauri-plugin-updater` cannot replace a `.deb` or `.rpm` install — on Linux it
//! only supports AppImage, because that is the only format where the running binary
//! is a single file the app may rewrite. Packages installed through apt/dnf are owned
//! by the system package manager and must be updated through it.
//!
//! Windows has the same problem in a different shape. The release also ships a
//! portable `.exe` — one file, no installation — and there an update is not an
//! in-place rewrite at all: the updater downloads the NSIS setup and runs it, which
//! would *install* julIDE beside the portable copy and leave the copy the user
//! actually launches at the old version.
//!
//! Rather than hiding the update entirely for those users, julIDE still *checks* and
//! tells them a new version exists; it just points them at the download page instead
//! of offering a button that would fail.

use serde::{Deserialize, Serialize};
#[cfg(any(target_os = "windows", test))]
use std::path::{Path, PathBuf};

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
    // A path we cannot read is not something to guess about: every download except
    // the portable one is an install, so that is the safer assumption.
    let installed = std::env::current_exe()
        .map(|exe| is_installed_location(&exe, &installer_roots()))
        .unwrap_or(true);

    if installed {
        InstallCapability {
            can_self_install: true,
            reason: None,
            format: "installer".to_string(),
        }
    } else {
        InstallCapability {
            can_self_install: false,
            reason: Some(
                "This is the portable build, which cannot replace itself — a Windows update \
                 runs an installer, and that would install julIDE separately rather than \
                 update this file. Download the new portable build to upgrade."
                    .to_string(),
            ),
            format: "portable".to_string(),
        }
    }
}

/// The directories a julIDE installer writes into: the MSI lands under Program Files,
/// the NSIS setup under `%LOCALAPPDATA%`. The portable `.exe` runs from wherever it was
/// put — Downloads, a project folder, a USB stick — so a binary outside all of these is
/// taken to be that one.
///
/// Erring towards "installed" is deliberate. Mislabelling an install as portable costs
/// a one-click update; mislabelling the portable build as an install runs an installer
/// the user did not ask for.
#[cfg(any(target_os = "windows", test))]
fn installer_roots() -> Vec<PathBuf> {
    [
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "LOCALAPPDATA",
    ]
    .iter()
    .filter_map(std::env::var_os)
    .map(PathBuf::from)
    .collect()
}

/// Whether `exe` sits under any of `roots`.
///
/// Compared case-insensitively and separator-insensitively, because Windows treats
/// paths that way and the case the environment reports need not match the case
/// `current_exe` reports for the same directory.
#[cfg(any(target_os = "windows", test))]
fn is_installed_location(exe: &Path, roots: &[PathBuf]) -> bool {
    fn normalise(p: &Path) -> String {
        p.to_string_lossy().replace('/', "\\").to_lowercase()
    }

    let exe = normalise(exe);
    roots.iter().any(|root| {
        let root = normalise(root);
        let root = root.trim_end_matches('\\');
        // The trailing separator keeps `C:\Program Files (x86)Extra\` from matching
        // the `C:\Program Files` root by prefix alone.
        !root.is_empty() && exe.starts_with(&format!("{root}\\"))
    })
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

    // The Windows portable/installed split is pure path logic, so it is tested on
    // every platform rather than only on a Windows runner — CI has none.
    #[test]
    fn binaries_under_an_installer_root_are_installed() {
        let roots = vec![
            PathBuf::from(r"C:\Program Files"),
            PathBuf::from(r"C:\Users\ofek\AppData\Local"),
        ];

        for exe in [
            r"C:\Program Files\julide\julide.exe",
            r"C:\Users\ofek\AppData\Local\julide\julide.exe",
        ] {
            assert!(
                is_installed_location(Path::new(exe), &roots),
                "expected installed: {exe}"
            );
        }
    }

    #[test]
    fn binaries_anywhere_else_are_portable() {
        let roots = vec![PathBuf::from(r"C:\Program Files")];

        for exe in [
            r"C:\Users\ofek\Downloads\julide_0.5.0_x64-portable.exe",
            r"E:\julide.exe",
            r"C:\dev\julide\julide.exe",
            // Prefix-matches the root as a string, but is a different directory.
            r"C:\Program Files Portable\julide.exe",
        ] {
            assert!(
                !is_installed_location(Path::new(exe), &roots),
                "expected portable: {exe}"
            );
        }
    }

    #[test]
    fn installed_location_ignores_case_and_separators() {
        let roots = vec![PathBuf::from(r"C:\Program Files")];
        assert!(is_installed_location(
            Path::new(r"c:/PROGRAM FILES/julide/julide.exe"),
            &roots
        ));
    }

    #[test]
    fn no_installer_roots_means_portable() {
        // An environment with none of the variables set must not match everything.
        assert!(!is_installed_location(
            Path::new(r"C:\Program Files\julide\julide.exe"),
            &[PathBuf::new()]
        ));
    }

    #[test]
    fn installer_roots_are_absolute_when_present() {
        for root in installer_roots() {
            assert!(root.is_absolute(), "not absolute: {}", root.display());
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
