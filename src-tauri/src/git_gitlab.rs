use async_trait::async_trait;
use reqwest::Client;
use serde_json::Value;

use crate::git_provider::{CiCheck, GitProvider, Issue, PullRequest, RepoInfo};

pub struct GitlabProvider {
    api_base: String,
    owner: String,
    repo: String,
}

impl GitlabProvider {
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
                    "PRIVATE-TOKEN",
                    crate::git_provider::auth_header_value(token)?,
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

    /// URL-encoded project ID: owner%2Frepo
    fn project_id(&self) -> String {
        format!(
            "{}%2F{}",
            urlencoding_encode(&self.owner),
            urlencoding_encode(&self.repo)
        )
    }

    fn api_url(&self, path: &str) -> String {
        format!(
            "{}/api/v4/projects/{}{}",
            self.api_base,
            self.project_id(),
            path
        )
    }
}

/// Simple percent-encoding for path segments
fn urlencoding_encode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

async fn check_response(resp: reqwest::Response) -> Result<Value, String> {
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("GitLab API error ({}): {}", status, body));
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
impl GitProvider for GitlabProvider {
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
            full_name: val_str(&v, "path_with_namespace"),
            default_branch: val_str(&v, "default_branch"),
            url: val_str(&v, "web_url"),
            provider: "gitlab".to_string(),
        })
    }

    async fn list_pull_requests(
        &self,
        token: &str,
        state: &str,
    ) -> Result<Vec<PullRequest>, String> {
        let client = self.client(token)?;
        // GitLab uses "opened"/"closed"/"merged" for MR state
        let gl_state = match state {
            "open" => "opened",
            other => other,
        };
        let resp = client
            .get(self.api_url(&format!("/merge_requests?state={}&per_page=50", gl_state)))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let v = check_response(resp).await?;
        let arr = v.as_array().ok_or("Expected array")?;
        let mut prs = Vec::new();
        for mr in arr {
            prs.push(PullRequest {
                number: val_u64(mr, "iid"),
                title: val_str(mr, "title"),
                state: val_str(mr, "state"),
                author: mr
                    .get("author")
                    .and_then(|a| a.get("username"))
                    .and_then(|u| u.as_str())
                    .unwrap_or("")
                    .to_string(),
                source_branch: val_str(mr, "source_branch"),
                target_branch: val_str(mr, "target_branch"),
                url: val_str(mr, "web_url"),
                created_at: val_str(mr, "created_at"),
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
            "description": body,
            "source_branch": source,
            "target_branch": target,
        });
        let resp = client
            .post(self.api_url("/merge_requests"))
            .json(&payload)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let mr = check_response(resp).await?;
        Ok(PullRequest {
            number: val_u64(&mr, "iid"),
            title: val_str(&mr, "title"),
            state: val_str(&mr, "state"),
            author: mr
                .get("author")
                .and_then(|a| a.get("username"))
                .and_then(|u| u.as_str())
                .unwrap_or("")
                .to_string(),
            source_branch: val_str(&mr, "source_branch"),
            target_branch: val_str(&mr, "target_branch"),
            url: val_str(&mr, "web_url"),
            created_at: val_str(&mr, "created_at"),
        })
    }

    async fn merge_pull_request(&self, token: &str, number: u64) -> Result<(), String> {
        let client = self.client(token)?;
        let resp = client
            .put(self.api_url(&format!("/merge_requests/{}/merge", number)))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.map_err(|e| e.to_string())?;
            return Err(format!("Failed to merge MR ({}): {}", status, body));
        }
        Ok(())
    }

    async fn list_issues(&self, token: &str, state: &str) -> Result<Vec<Issue>, String> {
        let client = self.client(token)?;
        // GitLab uses "opened"/"closed" for issue state
        let gl_state = match state {
            "open" => "opened",
            other => other,
        };
        let resp = client
            .get(self.api_url(&format!("/issues?state={}&per_page=50", gl_state)))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let v = check_response(resp).await?;
        let arr = v.as_array().ok_or("Expected array")?;
        let mut issues = Vec::new();
        for issue in arr {
            issues.push(Issue {
                number: val_u64(issue, "iid"),
                title: val_str(issue, "title"),
                state: val_str(issue, "state"),
                author: issue
                    .get("author")
                    .and_then(|a| a.get("username"))
                    .and_then(|u| u.as_str())
                    .unwrap_or("")
                    .to_string(),
                labels: issue
                    .get("labels")
                    .and_then(|l| l.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|l| l.as_str())
                            .map(|s| s.to_string())
                            .collect()
                    })
                    .unwrap_or_default(),
                url: val_str(issue, "web_url"),
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
            "description": body,
            "labels": labels.join(","),
        });
        let resp = client
            .post(self.api_url("/issues"))
            .json(&payload)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let issue = check_response(resp).await?;
        Ok(Issue {
            number: val_u64(&issue, "iid"),
            title: val_str(&issue, "title"),
            state: val_str(&issue, "state"),
            author: issue
                .get("author")
                .and_then(|a| a.get("username"))
                .and_then(|u| u.as_str())
                .unwrap_or("")
                .to_string(),
            labels: issue
                .get("labels")
                .and_then(|l| l.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|l| l.as_str())
                        .map(|s| s.to_string())
                        .collect()
                })
                .unwrap_or_default(),
            url: val_str(&issue, "web_url"),
            created_at: val_str(&issue, "created_at"),
        })
    }

    async fn get_ci_status(&self, token: &str, ref_name: &str) -> Result<Vec<CiCheck>, String> {
        let client = self.client(token)?;
        let resp = client
            .get(self.api_url(&format!("/pipelines?ref={}&per_page=5", ref_name)))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let v = check_response(resp).await?;
        let arr = v.as_array().ok_or("Expected array")?;
        let mut checks = Vec::new();
        for pipeline in arr {
            checks.push(CiCheck {
                name: format!("Pipeline #{}", val_u64(pipeline, "id")),
                status: val_str(pipeline, "status"),
                conclusion: Some(val_str(pipeline, "status")),
                url: pipeline
                    .get("web_url")
                    .and_then(|u| u.as_str())
                    .map(|s| s.to_string()),
            });
        }
        Ok(checks)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn val_str_present() {
        let obj = json!({"title": "Fix bug"});
        assert_eq!(val_str(&obj, "title"), "Fix bug");
    }

    #[test]
    fn val_str_missing() {
        let obj = json!({});
        assert_eq!(val_str(&obj, "title"), "");
    }

    #[test]
    fn val_u64_present() {
        let obj = json!({"iid": 99});
        assert_eq!(val_u64(&obj, "iid"), 99);
    }

    #[test]
    fn val_u64_missing() {
        let obj = json!({});
        assert_eq!(val_u64(&obj, "iid"), 0);
    }

    #[test]
    fn urlencoding_encodes_slash() {
        let encoded = urlencoding_encode("owner/repo");
        assert!(encoded.contains("%2F") || encoded.contains("%2f"));
    }
}
