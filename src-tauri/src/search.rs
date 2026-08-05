use serde::Serialize;
use std::fs;
use walkdir::WalkDir;

#[derive(Serialize, Clone)]
pub struct SearchResult {
    pub file: String,
    pub line: u32,
    pub col: u32,
    pub text: String,
    pub match_text: String,
}

/// Directories to always skip when searching.
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "__pycache__",
    ".julia",
    "dist",
    ".next",
    ".vscode",
];

/// Maximum total results to return.
const MAX_RESULTS: usize = 5000;

/// Maximum file size (in bytes) to search — skip very large files.
const MAX_FILE_SIZE: u64 = 2 * 1024 * 1024; // 2 MB

fn is_likely_binary(buf: &[u8]) -> bool {
    buf.iter().take(512).any(|&b| b == 0)
}

#[tauri::command]
pub fn fs_search_files(
    workspace: String,
    query: String,
    is_regex: bool,
    case_sensitive: bool,
    file_glob: Option<String>,
) -> Result<Vec<SearchResult>, String> {
    if query.is_empty() {
        return Ok(vec![]);
    }

    let re = if is_regex {
        regex::RegexBuilder::new(&query)
            .case_insensitive(!case_sensitive)
            .build()
            .map_err(|e| format!("Invalid regex: {}", e))?
    } else {
        let escaped = regex::escape(&query);
        regex::RegexBuilder::new(&escaped)
            .case_insensitive(!case_sensitive)
            .build()
            .map_err(|e| format!("Search error: {}", e))?
    };

    // Compile optional glob filter
    let glob_pattern = file_glob
        .as_deref()
        .and_then(|g| glob::Pattern::new(g).ok());

    let mut results = Vec::new();

    for entry in WalkDir::new(&workspace)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy();
                // Skip hidden directories (except the root ".")
                if name.starts_with('.') && name != "." {
                    return false;
                }
                // Skip known noisy directories
                !SKIP_DIRS.contains(&name.as_ref())
            } else {
                true
            }
        })
    {
        if results.len() >= MAX_RESULTS {
            break;
        }

        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();

        // Check file size
        if let Ok(meta) = path.metadata() {
            if meta.len() > MAX_FILE_SIZE {
                continue;
            }
        }

        // Check glob filter
        if let Some(ref pat) = glob_pattern {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if !pat.matches(&name) {
                continue;
            }
        }

        // Read file
        let content = match fs::read(path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        // Skip binary files
        if is_likely_binary(&content) {
            continue;
        }

        let text = match String::from_utf8(content) {
            Ok(t) => t,
            Err(_) => continue,
        };

        let file_path = path.to_string_lossy().to_string();

        for (line_idx, line) in text.lines().enumerate() {
            if results.len() >= MAX_RESULTS {
                break;
            }
            if let Some(m) = re.find(line) {
                results.push(SearchResult {
                    file: file_path.clone(),
                    line: (line_idx + 1) as u32,
                    col: (m.start() + 1) as u32,
                    text: line.to_string(),
                    match_text: m.as_str().to_string(),
                });
            }
        }
    }

    Ok(results)
}

/// Replace all occurrences of `query` with `replacement` in workspace files.
/// Returns the number of files modified and total replacements made.
#[tauri::command]
pub fn fs_replace_in_files(
    workspace: String,
    query: String,
    replacement: String,
    is_regex: bool,
    case_sensitive: bool,
    file_glob: Option<String>,
) -> Result<(usize, usize), String> {
    if query.is_empty() {
        return Ok((0, 0));
    }

    let re = if is_regex {
        regex::RegexBuilder::new(&query)
            .case_insensitive(!case_sensitive)
            .build()
            .map_err(|e| format!("Invalid regex: {}", e))?
    } else {
        let escaped = regex::escape(&query);
        regex::RegexBuilder::new(&escaped)
            .case_insensitive(!case_sensitive)
            .build()
            .map_err(|e| format!("Search error: {}", e))?
    };

    let glob_pattern = file_glob
        .as_deref()
        .and_then(|g| glob::Pattern::new(g).ok());

    let mut files_modified = 0usize;
    let mut total_replacements = 0usize;

    for entry in WalkDir::new(&workspace)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.file_type().is_dir() {
                let name = e.file_name().to_string_lossy();
                if name.starts_with('.') && name != "." {
                    return false;
                }
                !SKIP_DIRS.contains(&name.as_ref())
            } else {
                true
            }
        })
    {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();

        if let Ok(meta) = path.metadata() {
            if meta.len() > MAX_FILE_SIZE {
                continue;
            }
        }

        if let Some(ref pat) = glob_pattern {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if !pat.matches(&name) {
                continue;
            }
        }

        let content = match fs::read(path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        if is_likely_binary(&content) {
            continue;
        }

        let text = match String::from_utf8(content) {
            Ok(t) => t,
            Err(_) => continue,
        };

        let count = re.find_iter(&text).count();
        if count == 0 {
            continue;
        }

        let new_text = re.replace_all(&text, replacement.as_str()).to_string();
        if let Err(e) = fs::write(path, &new_text) {
            return Err(format!("Failed to write {}: {}", path.display(), e));
        }

        files_modified += 1;
        total_replacements += count;
    }

    Ok((files_modified, total_replacements))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_detection_with_null_byte() {
        assert!(is_likely_binary(&[0x48, 0x65, 0x6c, 0x00, 0x6f]));
    }

    #[test]
    fn binary_detection_normal_text() {
        assert!(!is_likely_binary(b"Hello, world!"));
    }

    #[test]
    fn binary_detection_empty() {
        assert!(!is_likely_binary(&[]));
    }

    #[test]
    fn binary_detection_null_at_position_511() {
        let mut buf = vec![0x41u8; 512];
        buf[511] = 0x00;
        assert!(is_likely_binary(&buf));
    }

    #[test]
    fn binary_detection_null_after_512_not_detected() {
        let mut buf = vec![0x41u8; 600];
        buf[513] = 0x00;
        // is_likely_binary only checks first 512 bytes
        assert!(!is_likely_binary(&buf));
    }

    /// Helper: create a workspace subdir inside the temp dir (avoids hidden-dir filtering
    /// when tempfile creates dirs with names starting with `.`).
    fn make_workspace(dir: &tempfile::TempDir) -> std::path::PathBuf {
        let ws = dir.path().join("workspace");
        std::fs::create_dir(&ws).unwrap();
        ws
    }

    #[test]
    fn search_in_temp_dir() {
        let dir = tempfile::tempdir().unwrap();
        let ws = make_workspace(&dir);
        std::fs::write(
            ws.join("test.jl"),
            "println(\"hello\")\nprintln(\"world\")\n",
        )
        .unwrap();

        let results = fs_search_files(
            ws.to_string_lossy().to_string(),
            "hello".to_string(),
            false,
            true,
            None,
        )
        .unwrap();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].line, 1);
        assert_eq!(results[0].col, 10);
        assert_eq!(results[0].match_text, "hello");
    }

    #[test]
    fn search_case_insensitive() {
        let dir = tempfile::tempdir().unwrap();
        let ws = make_workspace(&dir);
        std::fs::write(ws.join("test.jl"), "Hello World\n").unwrap();

        let results = fs_search_files(
            ws.to_string_lossy().to_string(),
            "hello".to_string(),
            false,
            false,
            None,
        )
        .unwrap();

        assert_eq!(results.len(), 1);
    }

    #[test]
    fn search_with_regex() {
        let dir = tempfile::tempdir().unwrap();
        let ws = make_workspace(&dir);
        std::fs::write(ws.join("test.jl"), "foo123bar\nfoo456bar\n").unwrap();

        let results = fs_search_files(
            ws.to_string_lossy().to_string(),
            r"foo\d+bar".to_string(),
            true,
            true,
            None,
        )
        .unwrap();

        assert_eq!(results.len(), 2);
    }

    #[test]
    fn search_with_glob_filter() {
        let dir = tempfile::tempdir().unwrap();
        let ws = make_workspace(&dir);
        std::fs::write(ws.join("test.jl"), "target\n").unwrap();
        std::fs::write(ws.join("test.txt"), "target\n").unwrap();

        let results = fs_search_files(
            ws.to_string_lossy().to_string(),
            "target".to_string(),
            false,
            true,
            Some("*.jl".to_string()),
        )
        .unwrap();

        assert_eq!(results.len(), 1);
        assert!(results[0].file.ends_with("test.jl"));
    }

    #[test]
    fn search_skips_binary_files() {
        let dir = tempfile::tempdir().unwrap();
        let ws = make_workspace(&dir);
        std::fs::write(ws.join("binary.bin"), [0x48, 0x65, 0x00, 0x6c]).unwrap();
        std::fs::write(ws.join("text.jl"), "hello\n").unwrap();

        let results = fs_search_files(
            ws.to_string_lossy().to_string(),
            "hel".to_string(),
            false,
            true,
            None,
        )
        .unwrap();

        assert_eq!(results.len(), 1);
        assert!(results[0].file.ends_with("text.jl"));
    }
}
