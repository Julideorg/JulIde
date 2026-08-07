use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub name: String,
    pub full_name: String,
    pub default_branch: String,
    pub url: String,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub author: String,
    pub source_branch: String,
    pub target_branch: String,
    pub url: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub author: String,
    pub labels: Vec<String>,
    pub url: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CiCheck {
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub url: Option<String>,
}

#[async_trait]
pub trait GitProvider: Send + Sync {
    async fn get_repo_info(&self, token: &str) -> Result<RepoInfo, String>;
    async fn list_pull_requests(
        &self,
        token: &str,
        state: &str,
    ) -> Result<Vec<PullRequest>, String>;
    async fn create_pull_request(
        &self,
        token: &str,
        title: &str,
        body: &str,
        source: &str,
        target: &str,
    ) -> Result<PullRequest, String>;
    async fn merge_pull_request(&self, token: &str, number: u64) -> Result<(), String>;
    async fn list_issues(&self, token: &str, state: &str) -> Result<Vec<Issue>, String>;
    async fn create_issue(
        &self,
        token: &str,
        title: &str,
        body: &str,
        labels: Vec<String>,
    ) -> Result<Issue, String>;
    async fn get_ci_status(&self, token: &str, ref_name: &str) -> Result<Vec<CiCheck>, String>;
}

/// Detect the git provider from a remote URL
pub fn detect_provider(remote_url: &str) -> Option<String> {
    if remote_url.contains("github.com") {
        Some("github".to_string())
    } else if remote_url.contains("gitlab.com") || remote_url.contains("gitlab.") {
        Some("gitlab".to_string())
    } else {
        // Could be Gitea or unknown — we'll try Gitea later via API check
        Some("gitea".to_string())
    }
}

/// Parse owner/repo from a remote URL (SSH or HTTPS)
pub fn parse_owner_repo(remote_url: &str) -> Option<(String, String)> {
    // HTTPS: https://github.com/owner/repo.git
    // SSH: git@github.com:owner/repo.git
    let url = remote_url.trim_end_matches(".git").trim_end_matches('/');

    if url.contains("://") {
        // HTTPS format
        let parts: Vec<&str> = url.split('/').collect();
        if parts.len() >= 2 {
            let repo = parts[parts.len() - 1];
            let owner = parts[parts.len() - 2];
            return Some((owner.to_string(), repo.to_string()));
        }
    } else if url.contains(':') {
        // SSH format: git@host:owner/repo
        if let Some(path) = url.split(':').next_back() {
            let parts: Vec<&str> = path.split('/').collect();
            if parts.len() == 2 {
                return Some((parts[0].to_string(), parts[1].to_string()));
            }
        }
    }
    None
}

/// Build an `Authorization`-style header value from a stored token.
///
/// `HeaderValue` only accepts visible ASCII, so a token pasted with a trailing
/// newline, a smart quote, or any non-ASCII character used to take the whole app
/// down through `.parse().unwrap()`. Surface it as a recoverable error instead, and
/// mark the value sensitive so it stays out of `Debug` output and logs.
pub fn auth_header_value(raw: &str) -> Result<reqwest::header::HeaderValue, String> {
    let mut value = reqwest::header::HeaderValue::from_str(raw.trim()).map_err(|_| {
        "The stored access token contains characters that are not valid in an HTTP header. \
         Re-enter it under Source Control → Auth settings."
            .to_string()
    })?;
    value.set_sensitive(true);
    Ok(value)
}

/// A host is loopback if it can only ever refer to this machine.
///
/// Plain HTTP is tolerated for these because a self-hosted Gitea on localhost is a
/// normal development setup and the token never leaves the machine.
fn is_loopback_host(host: &str) -> bool {
    host == "localhost"
        || host == "127.0.0.1"
        || host == "::1"
        || host == "[::1]"
        || host.ends_with(".localhost")
}

/// Extract the base API URL from a remote URL for self-hosted instances.
///
/// The scheme is forced to `https` for every non-loopback host. The stored personal
/// access token is sent to whatever this returns (`Authorization: token <PAT>`), so
/// honouring an `http://` remote would put the user's PAT on the wire in cleartext to
/// whatever host `origin` names — including one an attacker chose by shipping a repo
/// with a hostile `origin` configured.
pub fn extract_api_base(remote_url: &str) -> String {
    if remote_url.contains("github.com") {
        return "https://api.github.com".to_string();
    }
    if remote_url.contains("gitlab.com") {
        return "https://gitlab.com".to_string();
    }
    // For self-hosted, extract the host
    if remote_url.contains("://") {
        if let Ok(parsed) = url::Url::parse(remote_url) {
            if let Some(host) = parsed.host_str() {
                let scheme = if is_loopback_host(host) {
                    parsed.scheme()
                } else {
                    "https"
                };
                let port = parsed.port().map(|p| format!(":{}", p)).unwrap_or_default();
                return format!("{}://{}{}", scheme, host, port);
            }
        }
    } else if remote_url.contains('@') && remote_url.contains(':') {
        // SSH format: git@host:owner/repo — assume HTTPS API
        if let Some(host_part) = remote_url.split('@').nth(1) {
            if let Some(host) = host_part.split(':').next() {
                return format!("https://{}", host);
            }
        }
    }
    "https://localhost".to_string()
}

// ─── Helper to get remote URL from workspace ────────────────────────────────

fn get_origin_url(workspace_path: &str) -> Result<String, String> {
    let repo = git2::Repository::open(workspace_path).map_err(|e| e.to_string())?;
    let remote = repo
        .find_remote("origin")
        .map_err(|e| format!("No origin remote: {}", e))?;
    remote
        .url()
        .map(|s| s.to_string())
        .map_err(|_| "Remote URL is not valid UTF-8".to_string())
}

fn get_provider_and_token(
    workspace_path: &str,
) -> Result<(String, String, String, String), String> {
    let url = get_origin_url(workspace_path)?;
    let provider = detect_provider(&url).ok_or("Could not detect git provider")?;
    let token = crate::git_auth::get_stored_token_for_remote(&url).ok_or(format!(
        "No token stored for {} — configure a PAT in Settings > Git Providers",
        provider
    ))?;
    let (owner, repo) =
        parse_owner_repo(&url).ok_or("Could not parse owner/repo from remote URL")?;
    Ok((provider, token, owner, repo))
}

// ─── Tauri Commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn git_provider_detect(workspace_path: String) -> Result<Option<String>, String> {
    match get_origin_url(&workspace_path) {
        Ok(url) => Ok(detect_provider(&url)),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub async fn git_provider_repo_info(workspace_path: String) -> Result<RepoInfo, String> {
    let (provider, token, owner, repo) = get_provider_and_token(&workspace_path)?;
    let url = get_origin_url(&workspace_path)?;
    let api_base = extract_api_base(&url);
    match provider.as_str() {
        "github" => {
            crate::git_github::GithubProvider::new(&api_base, &owner, &repo)
                .get_repo_info(&token)
                .await
        }
        "gitlab" => {
            crate::git_gitlab::GitlabProvider::new(&api_base, &owner, &repo)
                .get_repo_info(&token)
                .await
        }
        "gitea" => {
            crate::git_gitea::GiteaProvider::new(&api_base, &owner, &repo)
                .get_repo_info(&token)
                .await
        }
        _ => Err("Unknown provider".to_string()),
    }
}

#[tauri::command]
pub async fn git_provider_list_prs(
    workspace_path: String,
    state: String,
) -> Result<Vec<PullRequest>, String> {
    let (provider, token, owner, repo) = get_provider_and_token(&workspace_path)?;
    let url = get_origin_url(&workspace_path)?;
    let api_base = extract_api_base(&url);
    match provider.as_str() {
        "github" => {
            crate::git_github::GithubProvider::new(&api_base, &owner, &repo)
                .list_pull_requests(&token, &state)
                .await
        }
        "gitlab" => {
            crate::git_gitlab::GitlabProvider::new(&api_base, &owner, &repo)
                .list_pull_requests(&token, &state)
                .await
        }
        "gitea" => {
            crate::git_gitea::GiteaProvider::new(&api_base, &owner, &repo)
                .list_pull_requests(&token, &state)
                .await
        }
        _ => Err("Unknown provider".to_string()),
    }
}

#[tauri::command]
pub async fn git_provider_create_pr(
    workspace_path: String,
    title: String,
    body: String,
    source: String,
    target: String,
) -> Result<PullRequest, String> {
    let (provider, token, owner, repo) = get_provider_and_token(&workspace_path)?;
    let url = get_origin_url(&workspace_path)?;
    let api_base = extract_api_base(&url);
    match provider.as_str() {
        "github" => {
            crate::git_github::GithubProvider::new(&api_base, &owner, &repo)
                .create_pull_request(&token, &title, &body, &source, &target)
                .await
        }
        "gitlab" => {
            crate::git_gitlab::GitlabProvider::new(&api_base, &owner, &repo)
                .create_pull_request(&token, &title, &body, &source, &target)
                .await
        }
        "gitea" => {
            crate::git_gitea::GiteaProvider::new(&api_base, &owner, &repo)
                .create_pull_request(&token, &title, &body, &source, &target)
                .await
        }
        _ => Err("Unknown provider".to_string()),
    }
}

#[tauri::command]
pub async fn git_provider_merge_pr(workspace_path: String, number: u64) -> Result<(), String> {
    let (provider, token, owner, repo) = get_provider_and_token(&workspace_path)?;
    let url = get_origin_url(&workspace_path)?;
    let api_base = extract_api_base(&url);
    match provider.as_str() {
        "github" => {
            crate::git_github::GithubProvider::new(&api_base, &owner, &repo)
                .merge_pull_request(&token, number)
                .await
        }
        "gitlab" => {
            crate::git_gitlab::GitlabProvider::new(&api_base, &owner, &repo)
                .merge_pull_request(&token, number)
                .await
        }
        "gitea" => {
            crate::git_gitea::GiteaProvider::new(&api_base, &owner, &repo)
                .merge_pull_request(&token, number)
                .await
        }
        _ => Err("Unknown provider".to_string()),
    }
}

#[tauri::command]
pub async fn git_provider_list_issues(
    workspace_path: String,
    state: String,
) -> Result<Vec<Issue>, String> {
    let (provider, token, owner, repo) = get_provider_and_token(&workspace_path)?;
    let url = get_origin_url(&workspace_path)?;
    let api_base = extract_api_base(&url);
    match provider.as_str() {
        "github" => {
            crate::git_github::GithubProvider::new(&api_base, &owner, &repo)
                .list_issues(&token, &state)
                .await
        }
        "gitlab" => {
            crate::git_gitlab::GitlabProvider::new(&api_base, &owner, &repo)
                .list_issues(&token, &state)
                .await
        }
        "gitea" => {
            crate::git_gitea::GiteaProvider::new(&api_base, &owner, &repo)
                .list_issues(&token, &state)
                .await
        }
        _ => Err("Unknown provider".to_string()),
    }
}

#[tauri::command]
pub async fn git_provider_create_issue(
    workspace_path: String,
    title: String,
    body: String,
    labels: Vec<String>,
) -> Result<Issue, String> {
    let (provider, token, owner, repo) = get_provider_and_token(&workspace_path)?;
    let url = get_origin_url(&workspace_path)?;
    let api_base = extract_api_base(&url);
    match provider.as_str() {
        "github" => {
            crate::git_github::GithubProvider::new(&api_base, &owner, &repo)
                .create_issue(&token, &title, &body, labels)
                .await
        }
        "gitlab" => {
            crate::git_gitlab::GitlabProvider::new(&api_base, &owner, &repo)
                .create_issue(&token, &title, &body, labels)
                .await
        }
        "gitea" => {
            crate::git_gitea::GiteaProvider::new(&api_base, &owner, &repo)
                .create_issue(&token, &title, &body, labels)
                .await
        }
        _ => Err("Unknown provider".to_string()),
    }
}

#[tauri::command]
pub async fn git_provider_ci_status(
    workspace_path: String,
    ref_name: String,
) -> Result<Vec<CiCheck>, String> {
    let (provider, token, owner, repo) = get_provider_and_token(&workspace_path)?;
    let url = get_origin_url(&workspace_path)?;
    let api_base = extract_api_base(&url);
    match provider.as_str() {
        "github" => {
            crate::git_github::GithubProvider::new(&api_base, &owner, &repo)
                .get_ci_status(&token, &ref_name)
                .await
        }
        "gitlab" => {
            crate::git_gitlab::GitlabProvider::new(&api_base, &owner, &repo)
                .get_ci_status(&token, &ref_name)
                .await
        }
        "gitea" => {
            crate::git_gitea::GiteaProvider::new(&api_base, &owner, &repo)
                .get_ci_status(&token, &ref_name)
                .await
        }
        _ => Err("Unknown provider".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── detect_provider ────────────────────────────────────────────────────

    #[test]
    fn detect_provider_github() {
        assert_eq!(
            detect_provider("https://github.com/user/repo.git"),
            Some("github".to_string())
        );
    }

    #[test]
    fn detect_provider_github_ssh() {
        assert_eq!(
            detect_provider("git@github.com:user/repo.git"),
            Some("github".to_string())
        );
    }

    #[test]
    fn detect_provider_gitlab() {
        assert_eq!(
            detect_provider("https://gitlab.com/user/repo.git"),
            Some("gitlab".to_string())
        );
    }

    #[test]
    fn detect_provider_gitlab_self_hosted() {
        assert_eq!(
            detect_provider("https://gitlab.mycompany.com/user/repo"),
            Some("gitlab".to_string())
        );
    }

    #[test]
    fn detect_provider_unknown_defaults_to_gitea() {
        assert_eq!(
            detect_provider("https://gitea.example.com/user/repo"),
            Some("gitea".to_string())
        );
    }

    // ── parse_owner_repo ───────────────────────────────────────────────────

    #[test]
    fn parse_owner_repo_https() {
        assert_eq!(
            parse_owner_repo("https://github.com/owner/repo.git"),
            Some(("owner".to_string(), "repo".to_string()))
        );
    }

    #[test]
    fn parse_owner_repo_https_no_git_suffix() {
        assert_eq!(
            parse_owner_repo("https://github.com/owner/repo"),
            Some(("owner".to_string(), "repo".to_string()))
        );
    }

    #[test]
    fn parse_owner_repo_ssh() {
        assert_eq!(
            parse_owner_repo("git@github.com:owner/repo.git"),
            Some(("owner".to_string(), "repo".to_string()))
        );
    }

    #[test]
    fn parse_owner_repo_ssh_no_git_suffix() {
        assert_eq!(
            parse_owner_repo("git@gitlab.com:user/project"),
            Some(("user".to_string(), "project".to_string()))
        );
    }

    #[test]
    fn parse_owner_repo_trailing_slash() {
        assert_eq!(
            parse_owner_repo("https://github.com/owner/repo/"),
            Some(("owner".to_string(), "repo".to_string()))
        );
    }

    // ── extract_api_base ───────────────────────────────────────────────────

    #[test]
    fn extract_api_base_github() {
        assert_eq!(
            extract_api_base("https://github.com/user/repo"),
            "https://api.github.com"
        );
    }

    #[test]
    fn extract_api_base_gitlab() {
        assert_eq!(
            extract_api_base("https://gitlab.com/user/repo"),
            "https://gitlab.com"
        );
    }

    #[test]
    fn extract_api_base_self_hosted_https() {
        assert_eq!(
            extract_api_base("https://git.mycompany.com/user/repo"),
            "https://git.mycompany.com"
        );
    }

    #[test]
    fn extract_api_base_self_hosted_with_port() {
        assert_eq!(
            extract_api_base("https://git.mycompany.com:8443/user/repo"),
            "https://git.mycompany.com:8443"
        );
    }

    #[test]
    fn extract_api_base_ssh_format() {
        assert_eq!(
            extract_api_base("git@myhost.com:user/repo.git"),
            "https://myhost.com"
        );
    }

    #[test]
    fn extract_api_base_fallback() {
        assert_eq!(extract_api_base("invalid-url"), "https://localhost");
    }

    // ── scheme forcing: the PAT must never travel over cleartext HTTP ───────

    #[test]
    fn extract_api_base_upgrades_http_to_https() {
        assert_eq!(
            extract_api_base("http://git.mycompany.com/user/repo"),
            "https://git.mycompany.com"
        );
    }

    #[test]
    fn extract_api_base_upgrades_hostile_http_remote() {
        // A repo shipped with a hostile `origin` must not cause the stored token
        // to be sent in cleartext to the attacker's host.
        assert_eq!(
            extract_api_base("http://attacker.example/foo/bar"),
            "https://attacker.example"
        );
    }

    #[test]
    fn extract_api_base_upgrades_http_but_keeps_port() {
        assert_eq!(
            extract_api_base("http://git.mycompany.com:3000/user/repo"),
            "https://git.mycompany.com:3000"
        );
    }

    #[test]
    fn extract_api_base_allows_http_on_loopback() {
        // Self-hosted Gitea on localhost is a normal dev setup; the token never
        // leaves the machine, so plain HTTP is fine here.
        assert_eq!(
            extract_api_base("http://localhost:3000/user/repo"),
            "http://localhost:3000"
        );
        assert_eq!(
            extract_api_base("http://127.0.0.1:3000/user/repo"),
            "http://127.0.0.1:3000"
        );
    }

    // ── auth_header_value ──────────────────────────────────────────────────

    #[test]
    fn auth_header_value_accepts_a_normal_token() {
        let v = auth_header_value("token ghp_abc123").expect("should accept ASCII");
        assert_eq!(v.to_str().unwrap(), "token ghp_abc123");
    }

    #[test]
    fn auth_header_value_trims_whitespace() {
        // Pasting a PAT commonly picks up a trailing newline.
        let v = auth_header_value("token ghp_abc123\n").expect("should trim and accept");
        assert_eq!(v.to_str().unwrap(), "token ghp_abc123");
    }

    #[test]
    fn auth_header_value_rejects_embedded_newlines_instead_of_panicking() {
        // A token carrying CRLF is a header-injection attempt. This used to be
        // `.parse().unwrap()`, which took the whole app down instead of erroring.
        let err = auth_header_value("token abc\r\nX-Injected: 1").unwrap_err();
        assert!(err.contains("not valid in an HTTP header"), "got: {err}");
    }

    #[test]
    fn auth_header_value_rejects_control_characters_instead_of_panicking() {
        let err = auth_header_value("token abc\u{0}def").unwrap_err();
        assert!(err.contains("not valid in an HTTP header"), "got: {err}");
    }

    #[test]
    fn auth_header_value_is_marked_sensitive() {
        let v = auth_header_value("token secret").unwrap();
        assert!(v.is_sensitive(), "token headers must not leak into logs");
    }
}
