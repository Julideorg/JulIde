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
                        let path_str = path.to_string_lossy().to_string();

                        // Skip hidden files and common noise directories
                        if path_str.contains("/.git/")
                            || path_str.contains("/node_modules/")
                            || path_str.contains("/target/")
                            || path_str.contains("/__pycache__/")
                        {
                            continue;
                        }

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
}
