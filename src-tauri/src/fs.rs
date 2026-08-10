use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileNode>>,
}

fn build_tree(path: &Path) -> FileNode {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());

    let is_dir = path.is_dir();

    if is_dir {
        let mut children: Vec<FileNode> = match std::fs::read_dir(path) {
            Ok(entries) => entries
                .filter_map(|e| e.ok())
                .filter(|e| {
                    // Skip hidden files and common ignored directories
                    let n = e.file_name();
                    let name = n.to_string_lossy();
                    !name.starts_with('.')
                        && name != "target"
                        && name != "node_modules"
                        && name != "__pycache__"
                })
                .map(|e| build_tree(&e.path()))
                .collect(),
            Err(_) => vec![],
        };
        // Dirs first, then files, alphabetical within each group
        children.sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        FileNode {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir: true,
            children: Some(children),
        }
    } else {
        FileNode {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir: false,
            children: None,
        }
    }
}

#[tauri::command]
pub fn fs_get_tree(path: String) -> Result<FileNode, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    Ok(build_tree(p))
}

#[tauri::command]
pub fn fs_read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Size and modification time, for change detection.
///
/// A missing file is `exists: false` rather than an error: the callers ask "has this
/// changed under me?", and "it is not there" is an answer to that, not a fault.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub exists: bool,
    pub is_dir: bool,
    pub size: u64,
    pub mtime_ms: u64,
}

#[tauri::command]
pub fn fs_stat(path: String) -> Result<FileStat, String> {
    let meta = match std::fs::metadata(&path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FileStat {
                exists: false,
                is_dir: false,
                size: 0,
                mtime_ms: 0,
            })
        }
        Err(e) => return Err(e.to_string()),
    };
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(FileStat {
        exists: true,
        is_dir: meta.is_dir(),
        size: meta.len(),
        mtime_ms,
    })
}

/// Write via a temporary file and a rename.
///
/// `fs_write_file` is a plain `std::fs::write`, which truncates first — fine for source
/// text, but a crash midway through a multi-megabyte `.ipynb` would lose every output it
/// held. The temp name is dot-prefixed so `build_tree` skips it, and a rename emits
/// Create/Remove rather than Modify, which the editor's reload path already ignores.
#[tauri::command]
pub fn fs_write_file_atomic(path: String, content: String) -> Result<(), String> {
    let target = Path::new(&path);
    let parent = target.parent().ok_or("path has no parent directory")?;
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("path has no file name")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    let tmp = parent.join(format!(".{name}.tmp"));
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

#[tauri::command]
pub fn fs_create_file(path: String) -> Result<(), String> {
    // Create parent dirs if needed
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::File::create(&path)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_create_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_delete_entry(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        std::fs::remove_dir_all(&path).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(&path).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn fs_rename(old_path: String, new_path: String) -> Result<(), String> {
    std::fs::rename(&old_path, &new_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
pub async fn dialog_open_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app
        .dialog()
        .file()
        .add_filter("Julia Files", &["jl"])
        .add_filter("All Files", &["*"])
        .blocking_pick_file();
    Ok(path.map(|p| p.to_string()))
}

#[tauri::command]
pub async fn dialog_pick_executable(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app
        .dialog()
        .file()
        .set_title("Select Julia Executable")
        .add_filter("All Files", &["*"])
        .blocking_pick_file();
    Ok(path.map(|p| p.to_string()))
}

#[tauri::command]
pub async fn dialog_open_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app.dialog().file().blocking_pick_folder();
    Ok(path.map(|p| p.to_string()))
}

#[tauri::command]
pub async fn dialog_save_file(
    app: tauri::AppHandle,
    default_name: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter("Julia Files", &["jl"])
        .add_filter("All Files", &["*"])
        .blocking_save_file();
    Ok(path.map(|p| p.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_tree_basic_structure() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("main.jl"), "").unwrap();
        std::fs::write(dir.path().join("README.md"), "").unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src").join("lib.jl"), "").unwrap();

        let tree = build_tree(dir.path());

        assert!(tree.is_dir);
        let children = tree.children.unwrap();
        // "src" dir should come before files
        assert!(children[0].is_dir);
        assert_eq!(children[0].name, "src");
    }

    #[test]
    fn build_tree_dirs_before_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("z_file.txt"), "").unwrap();
        std::fs::create_dir(dir.path().join("a_dir")).unwrap();

        let tree = build_tree(dir.path());
        let children = tree.children.unwrap();

        assert!(children[0].is_dir, "directory should come first");
        assert_eq!(children[0].name, "a_dir");
        assert!(!children[1].is_dir);
        assert_eq!(children[1].name, "z_file.txt");
    }

    #[test]
    fn build_tree_skips_hidden_and_noise_dirs() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        std::fs::create_dir(dir.path().join("node_modules")).unwrap();
        std::fs::create_dir(dir.path().join("target")).unwrap();
        std::fs::create_dir(dir.path().join("__pycache__")).unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("main.jl"), "").unwrap();

        let tree = build_tree(dir.path());
        let children = tree.children.unwrap();
        let names: Vec<&str> = children.iter().map(|c| c.name.as_str()).collect();

        assert!(!names.contains(&".git"));
        assert!(!names.contains(&"node_modules"));
        assert!(!names.contains(&"target"));
        assert!(!names.contains(&"__pycache__"));
        assert!(names.contains(&"src"));
        assert!(names.contains(&"main.jl"));
    }

    #[test]
    fn build_tree_alphabetical_within_groups() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("c.jl"), "").unwrap();
        std::fs::write(dir.path().join("a.jl"), "").unwrap();
        std::fs::write(dir.path().join("b.jl"), "").unwrap();

        let tree = build_tree(dir.path());
        let children = tree.children.unwrap();
        let names: Vec<&str> = children.iter().map(|c| c.name.as_str()).collect();

        assert_eq!(names, vec!["a.jl", "b.jl", "c.jl"]);
    }

    #[test]
    fn stat_reports_a_missing_file_as_absent_rather_than_erroring() {
        // Callers ask "did this change under me?"; "not there" is an answer.
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope.ipynb");
        let stat = fs_stat(missing.to_str().unwrap().into()).unwrap();
        assert!(!stat.exists);
        assert_eq!(stat.size, 0);
    }

    #[test]
    fn stat_reports_size_and_a_modification_time() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.jl");
        std::fs::write(&file, b"x = 1\n").unwrap();
        let stat = fs_stat(file.to_str().unwrap().into()).unwrap();
        assert!(stat.exists);
        assert!(!stat.is_dir);
        assert_eq!(stat.size, 6);
        assert!(stat.mtime_ms > 0);
    }

    #[test]
    fn atomic_write_replaces_the_target_and_leaves_no_temp_behind() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("nb.ipynb");
        std::fs::write(&file, b"old").unwrap();

        fs_write_file_atomic(file.to_str().unwrap().into(), "new".into()).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new");

        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "left behind: {leftovers:?}");
    }

    #[test]
    fn atomic_write_creates_missing_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("nested/deep/nb.ipynb");
        fs_write_file_atomic(file.to_str().unwrap().into(), "x".into()).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "x");
    }
}
