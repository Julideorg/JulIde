use async_trait::async_trait;
use reqwest::Client;
use serde_json::Value;

use crate::git_provider::{CiCheck, GitProvider, Issue, PullRequest, RepoInfo};

pub struct GithubProvider {
    api_base: String,
    owner: String,
    repo: String,
}

impl GithubProvider {
    pub fn new(api_base: &str, owner: &str, repo: &str) -> Self {
        Self {
            api_base: api_base.to_string(),
            owner: owner.to_string(),
            repo: repo.to_string(),
        }
    }

    fn client(&self, token: &str) -> Result<Client, String> {
        Client::builder()
            .default_headers({
                let mut headers = reqwest::header::HeaderMap::new();
                headers.insert(
                    reqwest::header::AUTHORIZATION,
                    crate::git_provider::auth_header_value(&format!("Bearer {}", token))?,
                );
                headers.insert(
                    reqwest::header::ACCEPT,
                    reqwest::header::HeaderValue::from_static("application/vnd.github+json"),
                );
                headers.insert(
                    reqwest::header::USER_AGENT,
                    reqwest::header::HeaderValue::from_static("JulIDE"),
                );
                headers
            })
            .build()
            .map_err(|e| e.to_string())
    }

    fn api_url(&self, path: &str) -> String {
        format!(
            "{}/repos/{}/{}{}",
            self.api_base, self.owner, self.repo, path
        )
    }
}

async fn check_response(resp: reqwest::Response) -> Result<Value, String> {
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("GitHub API error ({}): {}", status, body));
    }
    serde_json::from_str(&body).map_err(|e| format!("Failed to parse response: {}", e))
}

fn val_str(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn val_u64(v: &Value, key: &str) -> u64 {
    v.get(key).and_then(|v| v.as_u64()).unwrap_or(0)
}

#[async_trait]
impl GitProvider for GithubProvider {
    async fn get_repo_info(&self, token: &str) -> Result<RepoInfo, String> {
        let client = self.client(token)?;
        let resp = client
            .get(self.api_url(""))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let v = check_response(resp).await?;
        Ok(RepoInfo {
            name: val_str(&v, "name"),
            full_name: val_str(&v, "full_name"),
            default_branch: val_str(&v, "default_branch"),
            url: val_str(&v, "html_url"),
            provider: "github".to_string(),
        })
    }

    async fn list_pull_requests(
        &self,
        token: &str,
        state: &str,
    ) -> Result<Vec<PullRequest>, String> {
        let client = self.client(token)?;
        let resp = client
            .get(self.api_url(&format!("/pulls?state={}&per_page=50", state)))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let v = check_response(resp).await?;
        let arr = v.as_array().ok_or("Expected array")?;
        let mut prs = Vec::new();
        for pr in arr {
            prs.push(PullRequest {
                number: val_u64(pr, "number"),
                title: val_str(pr, "title"),
                state: val_str(pr, "state"),
                author: pr
                    .get("user")
                    .and_then(|u| u.get("login"))
                    .and_then(|l| l.as_str())
                    .unwrap_or("")
                    .to_string(),
                source_branch: pr
                    .get("head")
                    .and_then(|h| h.get("ref"))
                    .and_then(|r| r.as_str())
                    .unwrap_or("")
                    .to_string(),
                target_branch: pr
                    .get("base")
                    .and_then(|b| b.get("ref"))
                    .and_then(|r| r.as_str())
                    .unwrap_or("")
                    .to_string(),
                url: val_str(pr, "html_url"),
                created_at: val_str(pr, "created_at"),
            });
        }
        Ok(prs)
    }

    async fn create_pull_request(
        &self,
        token: &str,
        title: &str,
        body: &str,
        source: &str,
        target: &str,
    ) -> Result<PullRequest, String> {
        let client = self.client(token)?;
        let payload = serde_json::json!({
            "title": title,
            "body": body,
            "head": source,
            "base": target,
        });
        let resp = client
            .post(self.api_url("/pulls"))
            .json(&payload)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let pr = check_response(resp).await?;
        Ok(PullRequest {
            number: val_u64(&pr, "number"),
            title: val_str(&pr, "title"),
            state: val_str(&pr, "state"),
            author: pr
                .get("user")
                .and_then(|u| u.get("login"))
                .and_then(|l| l.as_str())
                .unwrap_or("")
                .to_string(),
            source_branch: pr
                .get("head")
                .and_then(|h| h.get("ref"))
                .and_then(|r| r.as_str())
                .unwrap_or("")
                .to_string(),
            target_branch: pr
                .get("base")
                .and_then(|b| b.get("ref"))
                .and_then(|r| r.as_str())
                .unwrap_or("")
                .to_string(),
            url: val_str(&pr, "html_url"),
            created_at: val_str(&pr, "created_at"),
        })
    }

    async fn merge_pull_request(&self, token: &str, number: u64) -> Result<(), String> {
        let client = self.client(token)?;
        let resp = client
            .put(self.api_url(&format!("/pulls/{}/merge", number)))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.map_err(|e| e.to_string())?;
            return Err(format!("Failed to merge PR ({}): {}", status, body));
        }
        Ok(())
    }

    async fn list_issues(&self, token: &str, state: &str) -> Result<Vec<Issue>, String> {
        let client = self.client(token)?;
        let resp = client
            .get(self.api_url(&format!("/issues?state={}&per_page=50", state)))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let v = check_response(resp).await?;
        let arr = v.as_array().ok_or("Expected array")?;
        let mut issues = Vec::new();
        for issue in arr {
            // Skip pull requests (GitHub returns PRs in the issues endpoint)
            if issue.get("pull_request").is_some() {
                continue;
            }
            issues.push(Issue {
                number: val_u64(issue, "number"),
                title: val_str(issue, "title"),
                state: val_str(issue, "state"),
                author: issue
                    .get("user")
                    .and_then(|u| u.get("login"))
                    .and_then(|l| l.as_str())
                    .unwrap_or("")
                    .to_string(),
                labels: issue
                    .get("labels")
                    .and_then(|l| l.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|l| l.get("name").and_then(|n| n.as_str()))
                            .map(|s| s.to_string())
                            .collect()
                    })
                    .unwrap_or_default(),
                url: val_str(issue, "html_url"),
                created_at: val_str(issue, "created_at"),
            });
        }
        Ok(issues)
    }

    async fn create_issue(
        &self,
        token: &str,
        title: &str,
        body: &str,
        labels: Vec<String>,
    ) -> Result<Issue, String> {
        let client = self.client(token)?;
        let payload = serde_json::json!({
            "title": title,
            "body": body,
            "labels": labels,
        });
        let resp = client
            .post(self.api_url("/issues"))
            .json(&payload)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let issue = check_response(resp).await?;
        Ok(Issue {
            number: val_u64(&issue, "number"),
            title: val_str(&issue, "title"),
            state: val_str(&issue, "state"),
            author: issue
                .get("user")
                .and_then(|u| u.get("login"))
                .and_then(|l| l.as_str())
                .unwrap_or("")
                .to_string(),
            labels: issue
                .get("labels")
                .and_then(|l| l.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|l| l.get("name").and_then(|n| n.as_str()))
                        .map(|s| s.to_string())
                        .collect()
                })
                .unwrap_or_default(),
            url: val_str(&issue, "html_url"),
            created_at: val_str(&issue, "created_at"),
        })
    }

    async fn get_ci_status(&self, token: &str, ref_name: &str) -> Result<Vec<CiCheck>, String> {
        let client = self.client(token)?;
        let resp = client
            .get(self.api_url(&format!("/commits/{}/check-runs", ref_name)))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let v = check_response(resp).await?;
        let checks = v
            .get("check_runs")
            .and_then(|c| c.as_array())
            .cloned()
            .unwrap_or_default();
        let mut results = Vec::new();
        for check in &checks {
            results.push(CiCheck {
                name: val_str(check, "name"),
                status: val_str(check, "status"),
                conclusion: check
                    .get("conclusion")
                    .and_then(|c| c.as_str())
                    .map(|s| s.to_string()),
                url: check
                    .get("html_url")
                    .and_then(|u| u.as_str())
                    .map(|s| s.to_string()),
            });
        }
        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn val_str_present() {
        let obj = json!({"name": "test-repo"});
        assert_eq!(val_str(&obj, "name"), "test-repo");
    }

    #[test]
    fn val_str_missing() {
        let obj = json!({});
        assert_eq!(val_str(&obj, "name"), "");
    }

    #[test]
    fn val_str_non_string() {
        let obj = json!({"count": 42});
        assert_eq!(val_str(&obj, "count"), "");
    }

    #[test]
    fn val_u64_present() {
        let obj = json!({"number": 42});
        assert_eq!(val_u64(&obj, "number"), 42);
    }

    #[test]
    fn val_u64_missing() {
        let obj = json!({});
        assert_eq!(val_u64(&obj, "number"), 0);
    }

    #[test]
    fn val_u64_non_number() {
        let obj = json!({"number": "not a number"});
        assert_eq!(val_u64(&obj, "number"), 0);
    }
}
