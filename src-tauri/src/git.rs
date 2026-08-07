use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    pub path: String,
    pub status: String, // "modified" | "added" | "deleted" | "untracked" | "renamed"
    pub staged: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitInfo {
    pub id: String,
    pub message: String,
    pub author: String,
    pub time: i64,
}

fn open_repo(workspace_path: &str) -> Result<git2::Repository, String> {
    git2::Repository::open(workspace_path).map_err(|e| format!("Not a git repository: {}", e))
}

#[tauri::command]
pub fn git_is_repo(workspace_path: String) -> bool {
    git2::Repository::open(&workspace_path).is_ok()
}

#[tauri::command]
pub fn git_branch_current(workspace_path: String) -> Result<String, String> {
    let repo = open_repo(&workspace_path)?;
    let head = repo.head().map_err(|e| e.to_string())?;
    Ok(head.shorthand().unwrap_or("HEAD (detached)").to_string())
}

#[tauri::command]
pub fn git_branches(workspace_path: String) -> Result<Vec<String>, String> {
    let repo = open_repo(&workspace_path)?;
    let branches = repo
        .branches(Some(git2::BranchType::Local))
        .map_err(|e| e.to_string())?;

    let mut names = Vec::new();
    for branch in branches {
        let (branch, _) = branch.map_err(|e| e.to_string())?;
        if let Some(name) = branch.name().map_err(|e| e.to_string())? {
            names.push(name.to_string());
        }
    }
    Ok(names)
}

#[tauri::command]
pub fn git_status(workspace_path: String) -> Result<Vec<GitFileStatus>, String> {
    let repo = open_repo(&workspace_path)?;
    let statuses = repo
        .statuses(Some(
            git2::StatusOptions::new()
                .include_untracked(true)
                .recurse_untracked_dirs(true),
        ))
        .map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for entry in statuses.iter() {
        let path = entry.path().unwrap_or("").to_string();
        let st = entry.status();

        if st.contains(git2::Status::INDEX_NEW) {
            results.push(GitFileStatus {
                path: path.clone(),
                status: "added".into(),
                staged: true,
            });
        }
        if st.contains(git2::Status::INDEX_MODIFIED) {
            results.push(GitFileStatus {
                path: path.clone(),
                status: "modified".into(),
                staged: true,
            });
        }
        if st.contains(git2::Status::INDEX_DELETED) {
            results.push(GitFileStatus {
                path: path.clone(),
                status: "deleted".into(),
                staged: true,
            });
        }
        if st.contains(git2::Status::INDEX_RENAMED) {
            results.push(GitFileStatus {
                path: path.clone(),
                status: "renamed".into(),
                staged: true,
            });
        }
        if st.contains(git2::Status::WT_MODIFIED) {
            results.push(GitFileStatus {
                path: path.clone(),
                status: "modified".into(),
                staged: false,
            });
        }
        if st.contains(git2::Status::WT_DELETED) {
            results.push(GitFileStatus {
                path: path.clone(),
                status: "deleted".into(),
                staged: false,
            });
        }
        if st.contains(git2::Status::WT_NEW) {
            results.push(GitFileStatus {
                path: path.clone(),
                status: "untracked".into(),
                staged: false,
            });
        }
        if st.contains(git2::Status::WT_RENAMED) {
            results.push(GitFileStatus {
                path: path.clone(),
                status: "renamed".into(),
                staged: false,
            });
        }
    }
    Ok(results)
}

#[tauri::command]
pub fn git_diff(workspace_path: String, file_path: Option<String>) -> Result<String, String> {
    let repo = open_repo(&workspace_path)?;
    let mut opts = git2::DiffOptions::new();
    if let Some(ref fp) = file_path {
        opts.pathspec(fp);
    }

    let diff = repo
        .diff_index_to_workdir(None, Some(&mut opts))
        .map_err(|e| e.to_string())?;

    let mut output = String::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        let prefix = match line.origin() {
            '+' => "+",
            '-' => "-",
            ' ' => " ",
            _ => "",
        };
        output.push_str(prefix);
        output.push_str(&String::from_utf8_lossy(line.content()));
        true
    })
    .map_err(|e| e.to_string())?;

    Ok(output)
}

#[tauri::command]
pub fn git_stage(workspace_path: String, file_paths: Vec<String>) -> Result<(), String> {
    let repo = open_repo(&workspace_path)?;
    let mut index = repo.index().map_err(|e| e.to_string())?;

    for path in &file_paths {
        let full_path = Path::new(&workspace_path).join(path);
        if full_path.exists() {
            index.add_path(Path::new(path)).map_err(|e| e.to_string())?;
        } else {
            index
                .remove_path(Path::new(path))
                .map_err(|e| e.to_string())?;
        }
    }

    index.write().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn git_unstage(workspace_path: String, file_paths: Vec<String>) -> Result<(), String> {
    let repo = open_repo(&workspace_path)?;
    let head = repo.head().map_err(|e| e.to_string())?;
    let head_commit = head.peel_to_commit().map_err(|e| e.to_string())?;
    let head_tree = head_commit.tree().map_err(|e| e.to_string())?;

    let mut index = repo.index().map_err(|e| e.to_string())?;

    for path in &file_paths {
        // Reset this path in the index to match HEAD
        if let Ok(entry) = head_tree.get_path(Path::new(path)) {
            let blob = repo.find_blob(entry.id()).map_err(|e| e.to_string())?;
            index
                .add_frombuffer(
                    &git2::IndexEntry {
                        ctime: git2::IndexTime::new(0, 0),
                        mtime: git2::IndexTime::new(0, 0),
                        dev: 0,
                        ino: 0,
                        mode: entry.filemode() as u32,
                        uid: 0,
                        gid: 0,
                        file_size: blob.size() as u32,
                        id: entry.id(),
                        flags: 0,
                        flags_extended: 0,
                        path: path.as_bytes().to_vec(),
                    },
                    blob.content(),
                )
                .map_err(|e| e.to_string())?;
        } else {
            // File didn't exist in HEAD — remove from index
            index
                .remove_path(Path::new(path))
                .map_err(|e| e.to_string())?;
        }
    }

    index.write().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn git_commit(workspace_path: String, message: String) -> Result<String, String> {
    let repo = open_repo(&workspace_path)?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    let tree_oid = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;

    let sig = repo
        .signature()
        .map_err(|e| format!("Git signature not configured: {}", e))?;
    let head = repo.head().map_err(|e| e.to_string())?;
    let parent = head.peel_to_commit().map_err(|e| e.to_string())?;

    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, &message, &tree, &[&parent])
        .map_err(|e| e.to_string())?;

    Ok(oid.to_string())
}

#[tauri::command]
pub fn git_log(workspace_path: String, limit: u32) -> Result<Vec<GitCommitInfo>, String> {
    let repo = open_repo(&workspace_path)?;
    let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
    revwalk.push_head().map_err(|e| e.to_string())?;
    revwalk
        .set_sorting(git2::Sort::TIME)
        .map_err(|e| e.to_string())?;

    let mut commits = Vec::new();
    for (i, oid) in revwalk.enumerate() {
        if i as u32 >= limit {
            break;
        }
        let oid = oid.map_err(|e| e.to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
        commits.push(GitCommitInfo {
            id: oid.to_string()[..8].to_string(),
            message: commit.summary().ok().flatten().unwrap_or("").to_string(),
            author: commit.author().name().unwrap_or("Unknown").to_string(),
            time: commit.time().seconds(),
        });
    }
    Ok(commits)
}

#[tauri::command]
pub fn git_checkout_branch(workspace_path: String, branch: String) -> Result<(), String> {
    let repo = open_repo(&workspace_path)?;
    let obj = repo
        .revparse_single(&format!("refs/heads/{}", branch))
        .map_err(|e| format!("Branch not found: {}", e))?;
    repo.checkout_tree(&obj, None).map_err(|e| e.to_string())?;
    repo.set_head(&format!("refs/heads/{}", branch))
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ─── New structs ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct GitRemote {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitStash {
    pub index: usize,
    pub message: String,
}

// ─── New commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn git_remotes(workspace_path: String) -> Result<Vec<GitRemote>, String> {
    let repo = open_repo(&workspace_path)?;
    let remote_names = repo.remotes().map_err(|e| e.to_string())?;
    let mut remotes = Vec::new();
    // `iter()` yields Result<Option<&str>> — Err for a non-UTF-8 name, Ok(None)
    // for an unnamed remote. Neither is addressable by name, so both are skipped.
    for name in remote_names.iter().filter_map(|n| n.ok().flatten()) {
        let remote = repo.find_remote(name).map_err(|e| e.to_string())?;
        let url = remote.url().unwrap_or("").to_string();
        remotes.push(GitRemote {
            name: name.to_string(),
            url,
        });
    }
    Ok(remotes)
}

#[tauri::command]
pub fn git_remote_url(workspace_path: String, remote: String) -> Result<String, String> {
    let repo = open_repo(&workspace_path)?;
    let r = repo
        .find_remote(&remote)
        .map_err(|e| format!("Remote '{}' not found: {}", remote, e))?;
    Ok(r.url().unwrap_or("").to_string())
}

#[tauri::command]
pub fn git_branch_create(
    workspace_path: String,
    name: String,
    checkout: bool,
) -> Result<(), String> {
    let repo = open_repo(&workspace_path)?;
    let head = repo.head().map_err(|e| e.to_string())?;
    let commit = head.peel_to_commit().map_err(|e| e.to_string())?;
    repo.branch(&name, &commit, false)
        .map_err(|e| format!("Failed to create branch: {}", e))?;
    if checkout {
        let obj = repo
            .revparse_single(&format!("refs/heads/{}", name))
            .map_err(|e| e.to_string())?;
        repo.checkout_tree(&obj, None).map_err(|e| e.to_string())?;
        repo.set_head(&format!("refs/heads/{}", name))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn git_branch_delete(workspace_path: String, name: String) -> Result<(), String> {
    let repo = open_repo(&workspace_path)?;
    let mut branch = repo
        .find_branch(&name, git2::BranchType::Local)
        .map_err(|e| format!("Branch '{}' not found: {}", name, e))?;
    branch.delete().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn git_merge(workspace_path: String, branch: String) -> Result<(), String> {
    let repo = open_repo(&workspace_path)?;

    let reference = repo
        .find_branch(&branch, git2::BranchType::Local)
        .map_err(|e| format!("Branch '{}' not found: {}", branch, e))?;
    let annotated = repo
        .reference_to_annotated_commit(reference.get())
        .map_err(|e| e.to_string())?;

    let (analysis, _pref) = repo
        .merge_analysis(&[&annotated])
        .map_err(|e| e.to_string())?;

    if analysis.is_up_to_date() {
        return Ok(());
    }

    if analysis.is_fast_forward() {
        // Fast-forward
        let target_oid = annotated.id();
        let mut head_ref = repo.head().map_err(|e| e.to_string())?;
        head_ref
            .set_target(target_oid, &format!("Fast-forward to {}", branch))
            .map_err(|e| e.to_string())?;
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    if analysis.is_normal() {
        // Normal merge
        repo.merge(&[&annotated], None, None)
            .map_err(|e| e.to_string())?;

        // Check for conflicts
        let index = repo.index().map_err(|e| e.to_string())?;
        if index.has_conflicts() {
            return Err("Merge resulted in conflicts. Please resolve them manually.".to_string());
        }

        // Create merge commit
        let mut index = repo.index().map_err(|e| e.to_string())?;
        let tree_oid = index.write_tree().map_err(|e| e.to_string())?;
        let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;
        let sig = repo
            .signature()
            .map_err(|e| format!("Git signature not configured: {}", e))?;
        let head_commit = repo
            .head()
            .map_err(|e| e.to_string())?
            .peel_to_commit()
            .map_err(|e| e.to_string())?;
        let merge_commit = repo
            .find_commit(annotated.id())
            .map_err(|e| e.to_string())?;

        repo.commit(
            Some("HEAD"),
            &sig,
            &sig,
            &format!("Merge branch '{}'", branch),
            &tree,
            &[&head_commit, &merge_commit],
        )
        .map_err(|e| e.to_string())?;

        // Clean up merge state
        repo.cleanup_state().map_err(|e| e.to_string())?;
        return Ok(());
    }

    Err("Merge not possible".to_string())
}

#[tauri::command]
pub fn git_stash_save(workspace_path: String, message: String) -> Result<(), String> {
    let mut repo = open_repo(&workspace_path)?;
    let sig = repo
        .signature()
        .map_err(|e| format!("Git signature not configured: {}", e))?;
    repo.stash_save(&sig, &message, None)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn git_stash_list(workspace_path: String) -> Result<Vec<GitStash>, String> {
    let mut repo = open_repo(&workspace_path)?;
    let mut stashes = Vec::new();
    repo.stash_foreach(|index, message, _oid| {
        stashes.push(GitStash {
            index,
            message: message.to_string(),
        });
        true
    })
    .map_err(|e| e.to_string())?;
    Ok(stashes)
}

#[tauri::command]
pub fn git_stash_pop(workspace_path: String, index: usize) -> Result<(), String> {
    let mut repo = open_repo(&workspace_path)?;
    repo.stash_pop(index, None).map_err(|e| e.to_string())?;
    Ok(())
}

/// Build credential callbacks for fetch/push/pull operations
fn make_remote_callbacks<'a>() -> git2::RemoteCallbacks<'a> {
    let mut callbacks = git2::RemoteCallbacks::new();
    callbacks.credentials(|url, username_from_url, allowed_types| {
        // Try SSH agent first
        if allowed_types.contains(git2::CredentialType::SSH_KEY) {
            if let Some(username) = username_from_url {
                return git2::Cred::ssh_key_from_agent(username);
            }
        }
        // Try stored token for HTTPS
        if allowed_types.contains(git2::CredentialType::USER_PASS_PLAINTEXT) {
            if let Some(token) = crate::git_auth::get_stored_token_for_remote(url) {
                let user = username_from_url.unwrap_or("git");
                return git2::Cred::userpass_plaintext(user, &token);
            }
        }
        // Fallback to default credentials
        git2::Cred::default()
    });
    callbacks
}

#[tauri::command]
pub fn git_fetch(workspace_path: String, remote: String) -> Result<(), String> {
    let repo = open_repo(&workspace_path)?;
    let mut rem = repo
        .find_remote(&remote)
        .map_err(|e| format!("Remote '{}' not found: {}", remote, e))?;
    let callbacks = make_remote_callbacks();
    let mut opts = git2::FetchOptions::new();
    opts.remote_callbacks(callbacks);
    rem.fetch(&[] as &[&str], Some(&mut opts), None)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn git_push(workspace_path: String, remote: String, branch: String) -> Result<(), String> {
    let repo = open_repo(&workspace_path)?;
    let mut rem = repo
        .find_remote(&remote)
        .map_err(|e| format!("Remote '{}' not found: {}", remote, e))?;
    let callbacks = make_remote_callbacks();
    let mut opts = git2::PushOptions::new();
    opts.remote_callbacks(callbacks);
    let refspec = format!("refs/heads/{}:refs/heads/{}", branch, branch);
    rem.push(&[&refspec], Some(&mut opts))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn git_pull(workspace_path: String, remote: String, branch: String) -> Result<(), String> {
    // Fetch first
    git_fetch(workspace_path.clone(), remote.clone())?;

    let repo = open_repo(&workspace_path)?;

    // Find the fetched reference
    let fetch_head = repo
        .find_reference(&format!("refs/remotes/{}/{}", remote, branch))
        .map_err(|e| format!("Remote branch '{}/{}' not found: {}", remote, branch, e))?;
    let annotated = repo
        .reference_to_annotated_commit(&fetch_head)
        .map_err(|e| e.to_string())?;

    let (analysis, _pref) = repo
        .merge_analysis(&[&annotated])
        .map_err(|e| e.to_string())?;

    if analysis.is_up_to_date() {
        return Ok(());
    }

    if analysis.is_fast_forward() {
        let target_oid = annotated.id();
        let mut head_ref = repo.head().map_err(|e| e.to_string())?;
        head_ref
            .set_target(
                target_oid,
                &format!("Pull fast-forward from {}/{}", remote, branch),
            )
            .map_err(|e| e.to_string())?;
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    if analysis.is_normal() {
        repo.merge(&[&annotated], None, None)
            .map_err(|e| e.to_string())?;

        let index = repo.index().map_err(|e| e.to_string())?;
        if index.has_conflicts() {
            return Err("Pull resulted in conflicts. Please resolve them manually.".to_string());
        }

        let mut index = repo.index().map_err(|e| e.to_string())?;
        let tree_oid = index.write_tree().map_err(|e| e.to_string())?;
        let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;
        let sig = repo
            .signature()
            .map_err(|e| format!("Git signature not configured: {}", e))?;
        let head_commit = repo
            .head()
            .map_err(|e| e.to_string())?
            .peel_to_commit()
            .map_err(|e| e.to_string())?;
        let merge_commit = repo
            .find_commit(annotated.id())
            .map_err(|e| e.to_string())?;

        repo.commit(
            Some("HEAD"),
            &sig,
            &sig,
            &format!("Merge {}/{} into {}", remote, branch, branch),
            &tree,
            &[&head_commit, &merge_commit],
        )
        .map_err(|e| e.to_string())?;

        repo.cleanup_state().map_err(|e| e.to_string())?;
        return Ok(());
    }

    Err("Pull merge not possible".to_string())
}

#[tauri::command]
pub fn git_ahead_behind(workspace_path: String) -> Result<(usize, usize), String> {
    let repo = open_repo(&workspace_path)?;
    let head = repo.head().map_err(|e| e.to_string())?;
    let local_oid = head
        .target()
        .ok_or_else(|| "HEAD is not a direct reference".to_string())?;

    // Find the upstream branch
    let branch_name = head
        .shorthand()
        .map_err(|_| "Could not get branch name".to_string())?
        .to_string();
    let branch = repo
        .find_branch(&branch_name, git2::BranchType::Local)
        .map_err(|e| e.to_string())?;
    let upstream = branch
        .upstream()
        .map_err(|_| "No upstream branch configured".to_string())?;
    let remote_oid = upstream
        .get()
        .target()
        .ok_or_else(|| "Upstream is not a direct reference".to_string())?;

    let (ahead, behind) = repo
        .graph_ahead_behind(local_oid, remote_oid)
        .map_err(|e| e.to_string())?;
    Ok((ahead, behind))
}

/// Retrieve a file's content from HEAD (or empty string for new files).
#[tauri::command]
pub fn git_show_file_at_head(workspace_path: String, file_path: String) -> Result<String, String> {
    let repo = open_repo(&workspace_path)?;
    let head = match repo.head() {
        Ok(h) => h,
        Err(_) => return Ok(String::new()), // No commits yet
    };
    let tree = head.peel_to_tree().map_err(|e| e.to_string())?;
    let entry = match tree.get_path(Path::new(&file_path)) {
        Ok(e) => e,
        Err(_) => return Ok(String::new()), // File doesn't exist in HEAD (new file)
    };
    let blob = repo.find_blob(entry.id()).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(blob.content()).to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLineInfo {
    pub line: u32,
    pub author: String,
    pub date: String,
    pub commit_id: String,
    pub summary: String,
}

/// Get blame info for a file.
#[tauri::command]
pub fn git_blame_file(
    workspace_path: String,
    file_path: String,
) -> Result<Vec<BlameLineInfo>, String> {
    let repo = open_repo(&workspace_path)?;
    let blame = repo
        .blame_file(Path::new(&file_path), None)
        .map_err(|e| format!("Blame failed: {}", e))?;

    let mut results = Vec::new();
    for hunk in blame.iter() {
        // git2 0.21 makes the signature optional — a hunk for a line that is not
        // committed yet has none. Fall back instead of skipping the hunk: skipping
        // would drop its lines and shift every later line in the blame gutter.
        let sig = hunk.final_signature();
        let author = sig
            .as_ref()
            .map(|s| String::from_utf8_lossy(s.name_bytes()).to_string())
            .unwrap_or_else(|| "Unknown".to_string());
        let time = sig.as_ref().map(|s| s.when());
        let secs = time.map_or(0, |t| t.seconds());
        // Format as YYYY-MM-DD
        let date = {
            let dt = secs + (time.map_or(0, |t| t.offset_minutes()) as i64) * 60;
            let days = dt / 86400 + 719468;
            let era = if days >= 0 { days } else { days - 146096 } / 146097;
            let doe = (days - era * 146097) as u32;
            let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
            let y = yoe as i64 + era * 400;
            let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
            let mp = (5 * doy + 2) / 153;
            let d = doy - (153 * mp + 2) / 5 + 1;
            let m = if mp < 10 { mp + 3 } else { mp - 9 };
            let y = if m <= 2 { y + 1 } else { y };
            format!("{:04}-{:02}-{:02}", y, m, d)
        };
        let oid = hunk.final_commit_id();
        let summary = repo
            .find_commit(oid)
            .map(|c| c.summary().ok().flatten().unwrap_or("").to_string())
            .unwrap_or_default();
        let start_line = hunk.final_start_line();
        let lines_in_hunk = hunk.lines_in_hunk();

        for i in 0..lines_in_hunk {
            results.push(BlameLineInfo {
                line: (start_line + i) as u32,
                author: author.clone(),
                date: date.clone(),
                commit_id: format!("{}", oid)[..7].to_string(),
                summary: summary.clone(),
            });
        }
    }

    results.sort_by_key(|b| b.line);
    Ok(results)
}
