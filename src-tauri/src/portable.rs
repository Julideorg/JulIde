//! Portable mode: keeping everything julIDE writes next to the executable.
//!
//! The Windows release ships a `-portable.exe` alongside the installers. Until now
//! that file was portable only in the sense that it did not *install* — it still
//! resolved settings to `%APPDATA%`, plugins to `%USERPROFILE%\.julide`, the
//! marketplace cache to `%LOCALAPPDATA%`, and let WebView2 create its own user-data
//! folder there as well. Run it from a USB stick on a lab machine and the
//! configuration stayed on the lab machine; plug the stick into the next one and
//! julIDE started from scratch, having left four directories behind on the first.
//!
//! This module is the single place that decides where state lives. Every other
//! module asks it rather than calling `dirs::` itself, so "portable" is one
//! decision made once at startup instead of a property each call site has to
//! remember to have.
//!
//! ## What turns it on
//!
//! Three signals, checked in this order:
//!
//! 1. `JULIDE_PORTABLE` in the environment — decides it outright, in both
//!    directions. `JULIDE_PORTABLE=0` forces the normal user-profile layout even
//!    for a build that would otherwise pick portable mode, which is the escape
//!    hatch when a machine's policy makes writing beside the binary a bad idea.
//! 2. A `julide-data` directory beside the executable. This is what makes the mode
//!    survive: julIDE creates the directory on its first portable launch, so from
//!    then on the *data* is what keeps the copy portable, and renaming the `.exe`
//!    cannot silently orphan it. It is also the opt-in for anyone who wants a
//!    self-built or renamed binary to be portable — create the folder, done.
//! 3. The executable's own name containing `portable`, which is what the release
//!    asset `julide_<version>_x64-portable.exe` is called. This is the signal that
//!    makes the download work on first run with nothing for the user to set up.
//!
//! ## Falling back
//!
//! A portable binary can easily end up somewhere it cannot write — a read-only
//! share, a CD, a directory the user has no rights to. Portable mode is therefore
//! confirmed by actually creating the directory and writing a probe file into it.
//! If that fails julIDE says so on stderr and uses the normal locations, because
//! starting with settings in the usual place beats failing to save anything.
//!
//! ## What stays outside
//!
//! Not everything can move, and pretending otherwise would be worse than saying so:
//!
//! - **Git credentials** stay in the OS credential store (`keyring`). The
//!   alternative is a token in a plain file on a stick that gets lost.
//! - **Julia itself**, its depot (`~/.julia`) and juliaup are not julIDE's to
//!   relocate. `JULIA_DEPOT_PATH` is the supported way to carry those, and it is
//!   Julia's switch, not ours.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Directory created beside the executable to hold everything julIDE writes.
const DATA_DIR: &str = "julide-data";

/// The bundle identifier, which is also the directory `app_config_dir()` appends.
/// Kept here rather than read from the Tauri config because the two callers of
/// [`window_state_file`] both run outside an `AppHandle`.
const IDENTIFIER: &str = "com.ofek.julide";

/// `tauri_plugin_window_state::DEFAULT_FILENAME`, which is not re-exported in a
/// form usable from a `const`.
const WINDOW_STATE_FILE: &str = ".window-state.json";

/// Values that turn `JULIDE_PORTABLE` off. Anything else set is an opt-in, so
/// `=1`, `=true` and `=yes` all work without this needing to enumerate them.
const FALSY: [&str; 5] = ["", "0", "false", "no", "off"];

/// Resolved exactly once. The answer involves creating a directory and probing it
/// for writes, and several commands ask for a path on every invocation.
static ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();

/// The portable data directory, or `None` when julIDE is running as an install.
pub fn data_root() -> Option<&'static Path> {
    ROOT.get_or_init(resolve).as_deref()
}

/// Whether this copy keeps its state beside the executable.
pub fn is_portable() -> bool {
    data_root().is_some()
}

/// julIDE's own configuration: settings, plugin permission grants, workspace trust.
pub fn config_dir() -> PathBuf {
    match data_root() {
        Some(root) => config_in(root),
        // `.` rather than a hard failure: a machine with no config directory at all
        // is broken in a way that should not stop the editor from opening.
        None => fallback(dirs::config_dir()).join("julide"),
    }
}

/// Larger, user-installed state — the plugins themselves and their staging area.
/// `~/.julide` on an installed copy, for the same reason `~/.vscode` exists: it is
/// content the user manages, not preferences.
pub fn state_dir() -> PathBuf {
    match data_root() {
        Some(root) => root.to_path_buf(),
        None => fallback(dirs::home_dir()).join(".julide"),
    }
}

/// Re-fetchable data. Deleting this costs a download, never a setting.
pub fn cache_dir() -> PathBuf {
    match data_root() {
        Some(root) => cache_in(root),
        None => fallback(dirs::cache_dir()).join("julide"),
    }
}

/// Installed plugins. One definition, because three modules resolve this path and
/// a portable build in which two of them agreed would be worse than one that did
/// not work at all.
pub fn plugins_dir() -> PathBuf {
    state_dir().join("plugins")
}

/// Where a plugin is unpacked before it is swapped into place.
///
/// Deliberately a sibling of `plugins/` rather than the system temp directory:
/// `fs::rename` fails with `EXDEV` across filesystems, and the whole point of
/// staging is that the final step is a rename that cannot half-succeed. In
/// portable mode this matters more, not less — the stick and `%TEMP%` are
/// certainly different filesystems.
pub fn staging_dir() -> PathBuf {
    state_dir().join(".staging")
}

/// Where `tauri-plugin-window-state` keeps the saved window geometry.
///
/// The plugin resolves this itself as `app_config_dir().join(filename)` and offers
/// no way to override the directory — only the file name. Passing an *absolute*
/// path as that "file name" is what moves it, because `Path::join` discards the
/// left-hand side when the right-hand side is absolute. It is a lever the plugin
/// did not intend to expose, so [`crate::settings::has_saved_window_state`] and
/// the plugin registration in `lib.rs` must agree on this one function rather
/// than each spelling the path out.
pub fn window_state_file() -> PathBuf {
    match data_root() {
        Some(root) => config_in(root).join(WINDOW_STATE_FILE),
        None => fallback(dirs::config_dir())
            .join(IDENTIFIER)
            .join(WINDOW_STATE_FILE),
    }
}

/// WebView2's user-data folder, and only in portable mode.
///
/// Returning `None` for an install is not an omission: Tauri picks the right
/// per-identifier location under `%LOCALAPPDATA%` on its own, and overriding it
/// would move every installed user's webview data for no reason.
pub fn webview_data_dir() -> Option<PathBuf> {
    data_root().map(|root| root.join("webview"))
}

/// Remove the empty directory the window-state plugin leaves in the user's profile.
///
/// The plugin writes its file wherever [`window_state_file`] points, but on the way
/// past it also runs `create_dir_all(app_config_dir())` — unconditionally, without
/// caring whether it then writes anything there. In portable mode that is an empty
/// `%APPDATA%\com.ofek.julide` appearing on a machine julIDE undertook to leave
/// alone, so it is swept up at exit, after the plugin has saved.
///
/// `remove_dir` rather than `remove_dir_all` is the entire safety argument: it fails
/// on a directory that is not empty. An installed copy's window state on the same
/// machine is a *file* in that directory, and a directory holding a file will not
/// go — so this cannot delete anything anyone has.
pub fn clean_profile_leftovers() {
    if !is_portable() {
        return;
    }
    if let Some(config) = dirs::config_dir() {
        let _ = std::fs::remove_dir(config.join(IDENTIFIER));
    }
}

fn fallback(dir: Option<PathBuf>) -> PathBuf {
    dir.unwrap_or_else(|| PathBuf::from("."))
}

// ─── Layout ─────────────────────────────────────────────────────────────────
//
// Split out so the shape of the portable tree can be asserted in tests without a
// process-global to fake. The tree is:
//
//   julide-data/
//     config/    settings.json, plugin-grants.json, workspace-trust.json,
//                .window-state.json
//     plugins/   installed plugins
//     .staging/  half-installed plugins, never seen by the user
//     cache/     marketplace index and icons
//     webview/   WebView2 profile

fn config_in(root: &Path) -> PathBuf {
    root.join("config")
}

fn cache_in(root: &Path) -> PathBuf {
    root.join("cache")
}

// ─── Detection ──────────────────────────────────────────────────────────────

fn resolve() -> Option<PathBuf> {
    // One path answers both questions — where the data folder goes and what the
    // file is called — so an AppImage named `julide-portable.AppImage` is matched
    // on the name the user sees rather than the `julide` it unpacks to.
    let launcher = launcher_path()?;
    let root = launcher.parent()?.join(DATA_DIR);

    let env = std::env::var("JULIDE_PORTABLE").ok();
    let stem = exe_stem(&launcher);
    if !wants_portable(env.as_deref(), stem.as_deref(), root.is_dir()) {
        return None;
    }

    match prepare(&root) {
        Ok(()) => Some(root),
        Err(e) => {
            // Release Windows builds have no console, so this reaches nobody there —
            // which is why the fallback has to be silent-but-working rather than
            // fatal. It is still worth printing for anyone running from a terminal.
            eprintln!(
                "julIDE: portable mode was requested but {} cannot be written to ({e}). \
                 Falling back to the usual per-user locations.",
                root.display()
            );
            None
        }
    }
}

/// The file the user actually launched.
fn launcher_path() -> Option<PathBuf> {
    // An AppImage is mounted before it runs, so `current_exe` inside one points at
    // a temporary mount (`/tmp/.mount_XXXX/usr/bin/julide`) that is gone by the next
    // launch — a `julide-data` folder created next to *that* would evaporate with it.
    // `APPIMAGE` holds the path of the file the user double-clicked, which is the one
    // the folder belongs beside.
    if let Some(appimage) = std::env::var_os("APPIMAGE") {
        return Some(PathBuf::from(appimage));
    }
    std::env::current_exe().ok()
}

/// The executable's file name without its extension, lowercased.
fn exe_stem(exe: &Path) -> Option<String> {
    exe.file_stem()
        .and_then(|s| s.to_str())
        .map(str::to_lowercase)
}

/// The decision itself, as a function of its three inputs.
///
/// Pure on purpose: portable mode is the kind of thing that is discovered to have
/// been wrong on a machine nobody can reproduce on, and a truth table that can be
/// asserted beats one that can only be observed.
fn wants_portable(env: Option<&str>, exe_stem: Option<&str>, data_dir_exists: bool) -> bool {
    if let Some(value) = env {
        return !FALSY.contains(&value.trim().to_lowercase().as_str());
    }
    data_dir_exists || exe_stem.is_some_and(|stem| stem.contains("portable"))
}

/// Create the data directory and prove it can be written to.
///
/// `create_dir_all` succeeding is not enough on its own: it is a no-op when the
/// directory already exists, which is exactly the case on a stick whose files were
/// copied read-only.
fn prepare(root: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(root)?;
    let probe = root.join(".write-probe");
    std::fs::write(&probe, b"")?;
    // A probe that cannot be cleaned up still proves the point, and an empty file
    // is not worth failing a startup over.
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_released_asset_name_turns_portable_mode_on() {
        // What CI actually publishes: julide_0.6.1_x64-portable.exe.
        assert!(wants_portable(
            None,
            Some("julide_0.6.1_x64-portable"),
            false
        ));
    }

    #[test]
    fn an_ordinary_binary_is_not_portable() {
        assert!(!wants_portable(None, Some("julide"), false));
        assert!(!wants_portable(None, None, false));
    }

    #[test]
    fn an_existing_data_directory_keeps_a_renamed_copy_portable() {
        // The case that matters: the user renames julide_0.6.1_x64-portable.exe to
        // julide.exe. The settings they already have must not vanish.
        assert!(wants_portable(None, Some("julide"), true));
    }

    #[test]
    fn the_environment_decides_in_both_directions() {
        for on in ["1", "true", "TRUE", "yes", "on", " 1 "] {
            assert!(wants_portable(Some(on), Some("julide"), false), "{on:?}");
        }
        for off in ["0", "false", "FALSE", "no", "off", ""] {
            // Off wins even over both other signals, or it is not an escape hatch.
            assert!(
                !wants_portable(Some(off), Some("x-portable"), true),
                "{off:?}"
            );
        }
    }

    #[test]
    fn every_portable_path_stays_under_the_root() {
        // The one invariant that makes "delete the folder and nothing is left"
        // true. A `..` anywhere here would write outside the stick.
        let root = Path::new("/media/stick/julide-data");
        for path in [config_in(root), cache_in(root), root.join("webview")] {
            assert!(
                path.starts_with(root),
                "escaped the root: {}",
                path.display()
            );
            assert!(
                !path.components().any(|c| c.as_os_str() == ".."),
                "traversal in: {}",
                path.display()
            );
        }
    }

    #[test]
    fn the_portable_directories_are_distinct() {
        // Sharing a directory between the marketplace cache and the config would
        // make "clear the cache" delete settings.
        let root = Path::new("/media/stick/julide-data");
        let dirs = [config_in(root), cache_in(root), root.join("webview")];
        for (i, a) in dirs.iter().enumerate() {
            for b in &dirs[i + 1..] {
                assert_ne!(a, b);
            }
        }
    }

    #[test]
    fn a_writable_directory_passes_the_probe_and_leaves_nothing_behind() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join(DATA_DIR);

        prepare(&root).unwrap();

        assert!(root.is_dir());
        assert!(
            !root.join(".write-probe").exists(),
            "probe file left behind"
        );
    }

    #[test]
    fn the_window_state_path_can_be_smuggled_past_the_plugin() {
        // The plugin does `app_config_dir().join(filename)`. Portable mode relies
        // on that `join` throwing the left side away, which only happens while the
        // path we hand it is absolute — so assert the property the trick rests on,
        // not just the string we produce.
        let file = config_in(Path::new("/media/stick/julide-data")).join(WINDOW_STATE_FILE);
        assert!(file.is_absolute());
        assert_eq!(
            Path::new("/home/ofek/.config/com.ofek.julide").join(&file),
            file
        );
    }

    #[test]
    fn the_leftover_sweep_cannot_take_anything_with_it() {
        // `clean_profile_leftovers` deletes a directory in the user's profile. The
        // only thing standing between that and an installed copy's window state is
        // `remove_dir` refusing a non-empty directory, so assert it refuses.
        let tmp = tempfile::tempdir().unwrap();

        let occupied = tmp.path().join("com.ofek.julide");
        std::fs::create_dir(&occupied).unwrap();
        std::fs::write(occupied.join(WINDOW_STATE_FILE), b"{}").unwrap();
        assert!(std::fs::remove_dir(&occupied).is_err());
        assert!(occupied.join(WINDOW_STATE_FILE).exists());

        let empty = tmp.path().join("empty");
        std::fs::create_dir(&empty).unwrap();
        assert!(std::fs::remove_dir(&empty).is_ok());
    }

    #[test]
    fn stems_are_matched_case_insensitively() {
        let exe = Path::new(r"C:\Users\ofek\Downloads\julIDE_0.6.1_x64-Portable.exe");
        assert!(wants_portable(None, exe_stem(exe).as_deref(), false));
    }
}
