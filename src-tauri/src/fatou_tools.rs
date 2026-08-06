//! Workspace-wide linting through Fatou's library API.
//!
//! The language server only ever diagnoses documents the editor has opened, so
//! a project's unopened files stay silent no matter how long the session runs.
//! Fatou's linter is an ordinary Rust API and it never needs Julia, so the
//! whole workspace can be checked directly — no second process, and nothing to
//! install.

use serde::Serialize;
use std::path::{Path, PathBuf};

use fatou::linter::{check_paths, Severity};
use fatou::text::line_index::LineIndex;

/// A lint finding in the shape the Problems panel already renders.
///
/// Mirrors the frontend's `Problem` (`src/types/index.ts`) field for field, so
/// results drop straight into the store alongside LSP diagnostics.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LintProblem {
    pub id: String,
    pub file: String,
    pub line: u32,
    pub col: u32,
    pub severity: String,
    pub message: String,
}

/// The frontend's `Problem.severity` union has no `hint`, so fold it into info.
fn severity_label(severity: Severity) -> &'static str {
    match severity {
        Severity::Error => "error",
        Severity::Warning => "warning",
        Severity::Info | Severity::Hint => "info",
    }
}

fn lint_workspace_blocking(root: PathBuf) -> Result<Vec<LintProblem>, String> {
    let result = check_paths(&[root]).map_err(|e| e.to_string())?;

    let mut problems = Vec::new();
    for report in result.reports {
        let (Some(path), false) = (report.path, report.diagnostics.is_empty()) else {
            continue;
        };

        // Findings carry byte offsets into the file; the panel wants line and
        // column, so the text has to be re-read to build a line index. Reading
        // once per file rather than once per finding keeps that cheap.
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let index = LineIndex::new(&text);
        let file = path_to_string(&path);

        for (i, diagnostic) in report.diagnostics.iter().enumerate() {
            let start = u32::from(diagnostic.range.start()) as usize;
            let position = index.byte_to_lc(start);
            problems.push(LintProblem {
                // Distinct from the `lsp-` prefix so the two sources can be
                // told apart when merging (see the lint.workspace command).
                id: format!("fatou-lint-{file}-{i}"),
                file: file.clone(),
                line: position.line as u32,
                col: position.column as u32,
                severity: severity_label(diagnostic.severity).to_string(),
                message: format!("{} [{}]", diagnostic.message.body, diagnostic.rule),
            });
        }
    }
    Ok(problems)
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

/// Lint every `.jl` file under `path`, including ones no editor tab has open.
#[tauri::command]
pub async fn fatou_lint_workspace(path: String) -> Result<Vec<LintProblem>, String> {
    // `check_paths` is synchronous and parallelises internally with rayon;
    // running it on an async worker would block the runtime for the duration.
    tokio::task::spawn_blocking(move || lint_workspace_blocking(PathBuf::from(path)))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn severity_hint_folds_into_info() {
        // The frontend union is error | warning | info; an unmapped "hint"
        // would render as an unstyled unknown severity.
        assert_eq!(severity_label(Severity::Error), "error");
        assert_eq!(severity_label(Severity::Warning), "warning");
        assert_eq!(severity_label(Severity::Info), "info");
        assert_eq!(severity_label(Severity::Hint), "info");
    }

    #[test]
    fn lints_a_file_no_editor_has_opened() {
        let dir = tempdir().unwrap();
        // `x` is assigned and never read — the `unused-binding` rule.
        fs::write(
            dir.path().join("bad.jl"),
            "function f()\n    x = 1\n    return 2\nend\n",
        )
        .unwrap();

        let problems = lint_workspace_blocking(dir.path().to_path_buf()).unwrap();

        assert_eq!(problems.len(), 1, "got: {problems:?}");
        let problem = &problems[0];
        assert!(problem.file.ends_with("bad.jl"));
        assert_eq!(problem.severity, "warning");
        assert!(
            problem.message.contains("unused-binding"),
            "got: {problem:?}"
        );
        // Findings arrive as byte offsets; they must reach the panel as
        // 1-indexed line and column, not as raw offsets into the file.
        assert_eq!((problem.line, problem.col), (2, 5));
        assert!(problem.id.starts_with("fatou-lint-"));
    }

    #[test]
    fn reports_parse_errors_too() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("broken.jl"), "function f(\n").unwrap();

        let problems = lint_workspace_blocking(dir.path().to_path_buf()).unwrap();

        assert!(!problems.is_empty());
        assert!(
            problems.iter().all(|p| p.severity == "error"),
            "got: {problems:?}"
        );
    }

    #[test]
    fn clean_source_reports_nothing() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("ok.jl"), "f(x) = x + 1\n").unwrap();

        assert!(lint_workspace_blocking(dir.path().to_path_buf())
            .unwrap()
            .is_empty());
    }
}
