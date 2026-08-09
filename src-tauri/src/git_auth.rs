use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AuthAccount {
    pub provider: String,
    pub has_token: bool,
}

const SERVICE_NAME: &str = "julide";

#[tauri::command]
pub fn git_auth_save_token(provider: String, token: String) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, &provider).map_err(|e| e.to_string())?;
    entry.set_password(&token).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn git_auth_get_token(provider: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SERVICE_NAME, &provider).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn git_auth_remove_token(provider: String) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, &provider).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn git_auth_list_accounts() -> Result<Vec<AuthAccount>, String> {
    let providers = ["github", "gitlab", "gitea"];
    let mut accounts = Vec::new();
    for provider in &providers {
        let has_token = match keyring::Entry::new(SERVICE_NAME, provider) {
            Ok(entry) => entry.get_password().is_ok(),
            Err(_) => false,
        };
        accounts.push(AuthAccount {
            provider: provider.to_string(),
            has_token,
        });
    }
    Ok(accounts)
}

/// Internal helper: get the stored token for a remote URL by detecting the provider.
///
/// Provider detection is delegated to `git_provider::detect_provider`, which matches on
/// the parsed host. It used to substring-match the whole URL here, which meant a repo
/// whose `origin` was `https://evil.com/github.com/x` was classified as GitHub and had
/// the user's GitHub PAT sent to `evil.com`'s API base — a credential handed over by
/// cloning a repository. Two copies of that decision is one too many, so there is now
/// only the one.
pub fn get_stored_token_for_remote(url: &str) -> Option<String> {
    let provider = crate::git_provider::detect_provider(url)?;
    keyring::Entry::new(SERVICE_NAME, &provider)
        .ok()
        .and_then(|e| e.get_password().ok())
}
