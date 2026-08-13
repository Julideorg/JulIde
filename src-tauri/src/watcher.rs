use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use once_cell::sync::Lazy;
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;
use tauri::Emitter;

#[derive(Clone, Serialize)]
pub struct FsChangedEvent {
    pub path: String,
    pub kind: String, // "create" | "modify" | "remove"
}

static WATCHER: Lazy<Mutex<Option<RecommendedWatcher>>> = Lazy::new(|| Mutex::new(None));

fn event_kind_str(kind: &notify::EventKind) -> Option<&'static str> {
    use notify::EventKind::*;
    match kind {
        Create(_) => Some("create"),
        Modify(_) => Some("modify"),
        Remove(_) => Some("remove"),
        _ => None,
    }
}

/// Directories whose churn is never worth telling the frontend about.
const NOISE_DIRS: [&str; 4] = [".git", "node_modules", "target", "__pycache__"];

/// Whether `path` sits under one of [`NOISE_DIRS`].
///
/// Matched on path *components*, not on a substring. This used to be four
/// `path_str.contains("/.git/")`-style tests, and `notify` hands us
/// `C:\proj\.git\index` on Windows — so not one of them ever fired there. Every
/// git write then reached the frontend, where it schedules a tree walk and a
/// `refreshGit()`; `refreshGit` runs eight git commands, which write to `.git`,
/// which woke the watcher again. A Windows workspace sat in that loop from the
/// moment it was opened.
///
/// Components are also the honest spelling of the check on every platform: the
/// old form silently depended on a separator that `Path` already knows how to
/// find, and it could not match a noise directory sitting at the very start of
/// a relative path.
///
/// Matched exactly rather than case-insensitively. These four names are all
/// spelled in lower case by the tools that create them, and a case-insensitive
/// test would hide a source directory someone deliberately called `Target` on
/// the filesystems where that is a different directory.
fn is_noise(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(component, std::path::Component::Normal(name)
            if NOISE_DIRS.iter().any(|dir| name == std::ffi::OsStr::new(dir)))
    })
}

#[tauri::command]
pub fn watcher_start(app: tauri::AppHandle, workspace_path: String) -> Result<(), String> {
    // Stop any existing watcher first
    {
        let mut lock = WATCHER.lock().map_err(|e| e.to_string())?;
        *lock = None;
    }

    let app_clone = app.clone();

    let watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                if let Some(kind) = event_kind_str(&event.kind) {
                    for path in &event.paths {
                        if is_noise(path) {
                            continue;
                        }
                        let path_str = path.to_string_lossy().to_string();

                        let _ = app_clone.emit(
                            "fs-changed",
                            FsChangedEvent {
                                path: path_str,
                                kind: kind.to_string(),
                            },
                        );
                    }
                }
            }
        },
        Config::default(),
    )
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    let mut w = watcher;
    w.watch(Path::new(&workspace_path), RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch path: {}", e))?;

    let mut lock = WATCHER.lock().map_err(|e| e.to_string())?;
    *lock = Some(w);

    Ok(())
}

#[tauri::command]
pub fn watcher_stop() -> Result<(), String> {
    let mut lock = WATCHER.lock().map_err(|e| e.to_string())?;
    *lock = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, CreateKind, ModifyKind, RemoveKind};

    #[test]
    fn event_kind_create() {
        assert_eq!(
            event_kind_str(&notify::EventKind::Create(CreateKind::Any)),
            Some("create")
        );
    }

    #[test]
    fn event_kind_modify() {
        assert_eq!(
            event_kind_str(&notify::EventKind::Modify(ModifyKind::Any)),
            Some("modify")
        );
    }

    #[test]
    fn event_kind_remove() {
        assert_eq!(
            event_kind_str(&notify::EventKind::Remove(RemoveKind::Any)),
            Some("remove")
        );
    }

    #[test]
    fn event_kind_access_returns_none() {
        assert_eq!(
            event_kind_str(&notify::EventKind::Access(AccessKind::Any)),
            None
        );
    }

    // ── is_noise ───────────────────────────────────────────────────────────
    //
    // `notify` reports paths in the platform's own spelling, so these run with
    // backslashes as well as slashes on every platform. The backslash cases are
    // the ones that regressed: the filter was four `contains("/.git/")` tests,
    // which are unreachable on Windows, and the whole point of moving to
    // components is that the separator stops being part of the check.

    #[test]
    fn skips_noise_directories_written_the_unix_way() {
        for path in [
            "/home/me/proj/.git/index",
            "/home/me/proj/node_modules/left-pad/index.js",
            "/home/me/proj/target/debug/julide",
            "/home/me/proj/__pycache__/mod.cpython-312.pyc",
        ] {
            assert!(is_noise(Path::new(path)), "{path} should be filtered");
        }
    }

    /// The Windows spelling, which the previous filter could not see at all.
    #[cfg(windows)]
    #[test]
    fn skips_noise_directories_written_the_windows_way() {
        for path in [
            r"C:\Users\me\proj\.git\index",
            r"C:\Users\me\proj\node_modules\left-pad\index.js",
            r"C:\Users\me\proj\target\debug\julide.exe",
            r"C:\Users\me\proj\__pycache__\mod.cpython-312.pyc",
            r"\\srv\share\proj\.git\ORIG_HEAD",
        ] {
            assert!(is_noise(Path::new(path)), "{path} should be filtered");
        }
    }

    #[test]
    fn keeps_source_files() {
        for path in ["/home/me/proj/src/a.jl", "/home/me/proj/Project.toml"] {
            assert!(!is_noise(Path::new(path)), "{path} should reach the UI");
        }
    }

    #[cfg(windows)]
    #[test]
    fn keeps_source_files_on_windows() {
        for path in [
            r"C:\Users\me\proj\src\a.jl",
            r"C:\Users\me\proj\Project.toml",
        ] {
            assert!(!is_noise(Path::new(path)), "{path} should reach the UI");
        }
    }

    /// A file whose *name* is a noise directory's name is still a file, and a
    /// directory that merely starts with one is a different directory.
    #[test]
    fn matches_whole_components_only() {
        assert!(!is_noise(Path::new("/home/me/proj/src/targets.jl")));
        assert!(!is_noise(Path::new("/home/me/proj/target-notes/a.jl")));
        assert!(!is_noise(Path::new("/home/me/proj/src/.gitignore")));
    }

    /// The old substring form needed a separator on both sides, so it missed a
    /// noise directory sitting at the head of a relative path.
    #[test]
    fn matches_a_leading_component() {
        assert!(is_noise(Path::new("target/debug/julide")));
        assert!(is_noise(Path::new(".git/index")));
    }

    /// Exact, not case-insensitive: on a case-sensitive filesystem `Target` is
    /// someone else's directory and skipping it would lose their edits.
    #[cfg(not(windows))]
    #[test]
    fn does_not_match_a_different_case() {
        assert!(!is_noise(Path::new("/home/me/proj/Target/a.jl")));
    }
}
