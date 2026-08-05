use crate::sync::LockRecover;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use tokio::io::AsyncBufReadExt;

// ─── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ContainerRuntimeKind {
    Docker,
    Podman,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerRuntimeConfig {
    pub kind: ContainerRuntimeKind,
    pub binary_path: String,
    pub remote_host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerInfo {
    pub id: String,
    pub name: String,
    pub image: String,
    pub status: String,
    pub state: String,
    pub ports: String,
    pub created: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    pub id: String,
    pub repository: String,
    pub tag: String,
    pub size: String,
    pub created: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum ContainerState {
    #[default]
    None,
    Building,
    Starting,
    Running,
    Stopped,
    Error,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerOutputEvent {
    pub kind: String,
    pub text: String,
    pub exit_code: Option<i32>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerStatusEvent {
    pub status: String,
    pub message: Option<String>,
    pub container_id: Option<String>,
}

// ─── DevContainer Config (Extended Spec) ─────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DevContainerConfig {
    pub name: Option<String>,
    pub image: Option<String>,
    pub build: Option<DevContainerBuild>,
    pub docker_compose_file: Option<StringOrArray>,
    pub service: Option<String>,

    pub workspace_folder: Option<String>,
    pub workspace_mount: Option<String>,

    pub forward_ports: Option<Vec<u16>>,

    pub initialize_command: Option<StringOrArray>,
    pub on_create_command: Option<StringOrArray>,
    pub update_content_command: Option<StringOrArray>,
    pub post_create_command: Option<StringOrArray>,
    pub post_start_command: Option<StringOrArray>,
    pub post_attach_command: Option<StringOrArray>,

    pub remote_user: Option<String>,
    pub container_user: Option<String>,
    pub container_env: Option<HashMap<String, String>>,
    pub remote_env: Option<HashMap<String, String>>,

    pub mounts: Option<Vec<serde_json::Value>>,
    pub features: Option<HashMap<String, serde_json::Value>>,

    pub run_args: Option<Vec<String>>,
    pub cap_add: Option<Vec<String>>,
    pub security_opt: Option<Vec<String>>,
    pub privileged: Option<bool>,

    pub shutdown_action: Option<String>,
    pub customizations: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DevContainerBuild {
    pub dockerfile: Option<String>,
    pub context: Option<String>,
    pub args: Option<HashMap<String, String>>,
    pub target: Option<String>,
    pub cache_from: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum StringOrArray {
    Single(String),
    Array(Vec<String>),
}

impl StringOrArray {
    pub fn to_shell_command(&self) -> String {
        match self {
            StringOrArray::Single(s) => s.clone(),
            StringOrArray::Array(arr) => arr.join(" "),
        }
    }
}

// ─── Global State ────────────────────────────────────────────────────────────

struct DevContainerState {
    runtime: Option<ContainerRuntimeConfig>,
    active_container_id: Option<String>,
    active_container_name: Option<String>,
    container_state: ContainerState,
}

impl Default for DevContainerState {
    fn default() -> Self {
        Self {
            runtime: None,
            active_container_id: None,
            active_container_name: None,
            container_state: ContainerState::None,
        }
    }
}

static CONTAINER_STATE: Lazy<Arc<Mutex<DevContainerState>>> =
    Lazy::new(|| Arc::new(Mutex::new(DevContainerState::default())));

static CACHED_RUNTIME: Lazy<Arc<Mutex<Option<ContainerRuntimeConfig>>>> =
    Lazy::new(|| Arc::new(Mutex::new(None)));

// ─── Runtime Detection ──────────────────────────────────────────────────────

fn which_via_shell(binary: &str) -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let output = std::process::Command::new(&shell)
        .args(["-l", "-c", &format!("which {}", binary)])
        .output()
        .ok()?;
    if output.status.success() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !path.is_empty() {
            return Some(path);
        }
    }
    None
}

fn find_binary(name: &str) -> Option<String> {
    // 1. Shell lookup
    if let Some(path) = which_via_shell(name) {
        return Some(path);
    }
    // 2. Common paths
    let common = [
        format!("/usr/bin/{}", name),
        format!("/usr/local/bin/{}", name),
        format!("/opt/homebrew/bin/{}", name),
    ];
    for p in &common {
        if Path::new(p).exists() {
            return Some(p.clone());
        }
    }
    None
}

fn validate_runtime(binary: &str) -> bool {
    std::process::Command::new(binary)
        .arg("info")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

async fn detect_runtime_impl(preferred: &str, remote_host: &str) -> Option<ContainerRuntimeConfig> {
    let remote = if remote_host.is_empty() {
        None
    } else {
        Some(remote_host.to_string())
    };

    // Check env override
    if let Ok(path) = std::env::var("CONTAINER_RUNTIME") {
        let kind = if path.contains("podman") {
            ContainerRuntimeKind::Podman
        } else {
            ContainerRuntimeKind::Docker
        };
        if validate_runtime(&path) {
            return Some(ContainerRuntimeConfig {
                kind,
                binary_path: path,
                remote_host: remote,
            });
        }
    }

    let try_order: Vec<(&str, ContainerRuntimeKind)> = match preferred {
        "docker" => vec![
            ("docker", ContainerRuntimeKind::Docker),
            ("podman", ContainerRuntimeKind::Podman),
        ],
        "podman" => vec![
            ("podman", ContainerRuntimeKind::Podman),
            ("docker", ContainerRuntimeKind::Docker),
        ],
        _ => vec![
            ("docker", ContainerRuntimeKind::Docker),
            ("podman", ContainerRuntimeKind::Podman),
        ],
    };

    for (name, kind) in try_order {
        if let Some(path) = find_binary(name) {
            if validate_runtime(&path) {
                return Some(ContainerRuntimeConfig {
                    kind,
                    binary_path: path,
                    remote_host: remote,
                });
            }
        }
    }

    None
}

// ─── Command Builder ─────────────────────────────────────────────────────────

fn build_cmd(config: &ContainerRuntimeConfig) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(&config.binary_path);
    if let Some(ref host) = config.remote_host {
        match config.kind {
            ContainerRuntimeKind::Docker => {
                cmd.arg("-H").arg(host);
            }
            ContainerRuntimeKind::Podman => {
                cmd.arg("--remote").arg("--url").arg(host);
            }
        }
    }
    cmd
}

fn get_runtime() -> Result<ContainerRuntimeConfig, String> {
    let cached = CACHED_RUNTIME.lock_recover();
    cached
        .clone()
        .ok_or_else(|| "No container runtime detected. Install Docker or Podman.".to_string())
}

fn emit_status(
    app: &tauri::AppHandle,
    status: &str,
    message: Option<&str>,
    container_id: Option<&str>,
) {
    let _ = app.emit(
        "container-status",
        ContainerStatusEvent {
            status: status.to_string(),
            message: message.map(|s| s.to_string()),
            container_id: container_id.map(|s| s.to_string()),
        },
    );
}

fn emit_output(app: &tauri::AppHandle, kind: &str, text: &str) {
    let _ = app.emit(
        "container-output",
        ContainerOutputEvent {
            kind: kind.to_string(),
            text: text.to_string(),
            exit_code: None,
        },
    );
}

// ─── Display Forwarding ─────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn get_display_forwarding_args_platform() -> Vec<String> {
    let mut args = Vec::new();
    // X11 socket — do NOT apply :Z here; the socket is shared and relabeling
    // it would break X11 for the host. Instead use :ro.
    if Path::new("/tmp/.X11-unix").exists() {
        args.push("-v".into());
        args.push("/tmp/.X11-unix:/tmp/.X11-unix:ro".into());
    }
    if let Ok(display) = std::env::var("DISPLAY") {
        args.push("--env".into());
        args.push(format!("DISPLAY={}", display));
    }
    if let Ok(xauth) = std::env::var("XAUTHORITY") {
        args.push("-v".into());
        args.push(format!("{}:{}:ro", xauth, xauth));
        args.push("--env".into());
        args.push(format!("XAUTHORITY={}", xauth));
    } else if let Ok(home) = std::env::var("HOME") {
        let xauth_path = format!("{}/.Xauthority", home);
        if Path::new(&xauth_path).exists() {
            args.push("-v".into());
            args.push(format!("{}:/root/.Xauthority:ro", xauth_path));
            args.push("--env".into());
            args.push("XAUTHORITY=/root/.Xauthority".into());
        }
    }
    // On SELinux systems, use --security-opt label=type:container_runtime_t to
    // allow the container to access the X11 socket without relabeling
    if detect_selinux() {
        args.push("--security-opt".into());
        args.push("label=type:container_runtime_t".into());
    }
    args.push("--net".into());
    args.push("host".into());
    args
}

#[cfg(target_os = "macos")]
fn get_display_forwarding_args_platform() -> Vec<String> {
    let mut args = Vec::new();
    args.push("--env".into());
    args.push("DISPLAY=host.docker.internal:0".into());
    if Path::new("/tmp/.X11-unix").exists() {
        args.push("-v".into());
        args.push("/tmp/.X11-unix:/tmp/.X11-unix:rw".into());
    }
    if let Ok(home) = std::env::var("HOME") {
        let xauth = format!("{}/.Xauthority", home);
        if Path::new(&xauth).exists() {
            args.push("-v".into());
            args.push(format!("{}:/root/.Xauthority:rw", xauth));
            args.push("--env".into());
            args.push("XAUTHORITY=/root/.Xauthority".into());
        }
    }
    args
}

#[cfg(target_os = "windows")]
fn get_display_forwarding_args_platform() -> Vec<String> {
    let mut args = Vec::new();
    if Path::new("/mnt/wslg").exists() {
        args.push("-v".into());
        args.push("/tmp/.X11-unix:/tmp/.X11-unix:rw".into());
        args.push("-v".into());
        args.push("/mnt/wslg:/mnt/wslg:rw".into());
        args.push("--env".into());
        args.push("DISPLAY=:0".into());
        args.push("--env".into());
        args.push("WAYLAND_DISPLAY=wayland-0".into());
        args.push("--env".into());
        args.push("XDG_RUNTIME_DIR=/mnt/wslg/runtime-dir".into());
    } else {
        args.push("--env".into());
        args.push("DISPLAY=host.docker.internal:0.0".into());
    }
    args
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn get_display_forwarding_args_platform() -> Vec<String> {
    Vec::new()
}

fn get_display_forwarding_args() -> Vec<String> {
    get_display_forwarding_args_platform()
}

// ─── SELinux Detection ───────────────────────────────────────────────────────

fn detect_selinux() -> bool {
    // Check if SELinux is enforcing or permissive (not disabled)
    #[cfg(target_os = "linux")]
    {
        if let Ok(output) = std::process::Command::new("getenforce").output() {
            let status = String::from_utf8_lossy(&output.stdout)
                .trim()
                .to_lowercase();
            return status == "enforcing" || status == "permissive";
        }
        // Fallback: check /sys/fs/selinux
        Path::new("/sys/fs/selinux/enforce").exists()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// Returns the volume suffix for bind mounts based on SELinux status.
/// `:Z` relabels the content to be accessible only by the specific container (private).
fn volume_suffix(selinux: bool) -> &'static str {
    if selinux {
        ":Z"
    } else {
        ""
    }
}

fn get_gpu_passthrough_args() -> Vec<String> {
    let mut args = Vec::new();
    if Path::new("/usr/bin/nvidia-smi").exists() {
        args.push("--gpus".into());
        args.push("all".into());
    }
    #[cfg(target_os = "linux")]
    if Path::new("/dev/dri").exists() {
        args.push("--device".into());
        args.push("/dev/dri:/dev/dri".into());
    }
    args
}

// ─── Tauri Commands: Runtime ─────────────────────────────────────────────────

#[tauri::command]
pub async fn container_detect_runtime(
    preferred: Option<String>,
    remote_host: Option<String>,
) -> Result<ContainerRuntimeConfig, String> {
    let pref = preferred.as_deref().unwrap_or("auto");
    let host = remote_host.as_deref().unwrap_or("");
    let config = detect_runtime_impl(pref, host)
        .await
        .ok_or_else(|| "No container runtime found. Install Docker or Podman.".to_string())?;
    {
        let mut cached = CACHED_RUNTIME.lock_recover();
        *cached = Some(config.clone());
    }
    {
        let mut state = CONTAINER_STATE.lock_recover();
        state.runtime = Some(config.clone());
    }
    Ok(config)
}

#[tauri::command]
pub async fn container_set_runtime(
    kind: String,
    binary_path: String,
    remote_host: Option<String>,
) -> Result<(), String> {
    let runtime_kind = match kind.as_str() {
        "podman" => ContainerRuntimeKind::Podman,
        _ => ContainerRuntimeKind::Docker,
    };
    let config = ContainerRuntimeConfig {
        kind: runtime_kind,
        binary_path,
        remote_host,
    };
    {
        let mut cached = CACHED_RUNTIME.lock_recover();
        *cached = Some(config.clone());
    }
    {
        let mut state = CONTAINER_STATE.lock_recover();
        state.runtime = Some(config);
    }
    Ok(())
}

// ─── Tauri Commands: Container Operations ────────────────────────────────────

#[tauri::command]
pub async fn container_list() -> Result<Vec<ContainerInfo>, String> {
    let rt = get_runtime()?;
    let mut cmd = build_cmd(&rt);
    cmd.args([
        "ps",
        "-a",
        "--format",
        "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.State}}\t{{.Ports}}\t{{.CreatedAt}}",
    ]);
    let output = cmd.output().await.map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let containers: Vec<ContainerInfo> = stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|line| {
            let parts: Vec<&str> = line.splitn(7, '\t').collect();
            ContainerInfo {
                id: parts.first().unwrap_or(&"").to_string(),
                name: parts.get(1).unwrap_or(&"").to_string(),
                image: parts.get(2).unwrap_or(&"").to_string(),
                status: parts.get(3).unwrap_or(&"").to_string(),
                state: parts.get(4).unwrap_or(&"").to_string(),
                ports: parts.get(5).unwrap_or(&"").to_string(),
                created: parts.get(6).unwrap_or(&"").to_string(),
            }
        })
        .collect();
    Ok(containers)
}

#[tauri::command]
pub async fn container_list_images() -> Result<Vec<ImageInfo>, String> {
    let rt = get_runtime()?;
    let mut cmd = build_cmd(&rt);
    cmd.args([
        "images",
        "--format",
        "{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedAt}}",
    ]);
    let output = cmd.output().await.map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let images: Vec<ImageInfo> = stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|line| {
            let parts: Vec<&str> = line.splitn(5, '\t').collect();
            ImageInfo {
                id: parts.first().unwrap_or(&"").to_string(),
                repository: parts.get(1).unwrap_or(&"").to_string(),
                tag: parts.get(2).unwrap_or(&"").to_string(),
                size: parts.get(3).unwrap_or(&"").to_string(),
                created: parts.get(4).unwrap_or(&"").to_string(),
            }
        })
        .collect();
    Ok(images)
}

#[tauri::command]
pub async fn container_inspect(container_id: String) -> Result<serde_json::Value, String> {
    let rt = get_runtime()?;
    let mut cmd = build_cmd(&rt);
    cmd.args(["inspect", &container_id]);
    let output = cmd.output().await.map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    let val: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
    Ok(val)
}

#[tauri::command]
pub async fn container_start(app: tauri::AppHandle, container_id: String) -> Result<(), String> {
    let rt = get_runtime()?;
    let mut cmd = build_cmd(&rt);
    cmd.args(["start", &container_id]);
    let output = cmd.output().await.map_err(|e| e.to_string())?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).to_string();
        emit_status(&app, "error", Some(&err), Some(&container_id));
        return Err(err);
    }
    emit_status(&app, "running", None, Some(&container_id));
    Ok(())
}

#[tauri::command]
pub async fn container_stop(app: tauri::AppHandle, container_id: String) -> Result<(), String> {
    let rt = get_runtime()?;
    let mut cmd = build_cmd(&rt);
    cmd.args(["stop", &container_id]);
    let output = cmd.output().await.map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    emit_status(&app, "stopped", None, Some(&container_id));
    {
        let mut state = CONTAINER_STATE.lock_recover();
        if state.active_container_id.as_deref() == Some(&container_id) {
            state.container_state = ContainerState::Stopped;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn container_restart(app: tauri::AppHandle, container_id: String) -> Result<(), String> {
    let rt = get_runtime()?;
    let mut cmd = build_cmd(&rt);
    cmd.args(["restart", &container_id]);
    let output = cmd.output().await.map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    emit_status(&app, "running", None, Some(&container_id));
    Ok(())
}

#[tauri::command]
pub async fn container_remove(container_id: String) -> Result<(), String> {
    let rt = get_runtime()?;
    let mut cmd = build_cmd(&rt);
    cmd.args(["rm", "-f", &container_id]);
    let output = cmd.output().await.map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    {
        let mut state = CONTAINER_STATE.lock_recover();
        if state.active_container_id.as_deref() == Some(&container_id) {
            state.active_container_id = None;
            state.active_container_name = None;
            state.container_state = ContainerState::None;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn container_logs(app: tauri::AppHandle, container_id: String) -> Result<(), String> {
    let rt = get_runtime()?;
    let mut cmd = build_cmd(&rt);
    cmd.args(["logs", "-f", "--tail", "200", &container_id])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    if let Some(stdout) = stdout {
        let app_out = app.clone();
        tokio::spawn(async move {
            let reader = tokio::io::BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                emit_output(&app_out, "stdout", &line);
            }
        });
    }
    if let Some(stderr) = stderr {
        let app_err = app.clone();
        tokio::spawn(async move {
            let reader = tokio::io::BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                emit_output(&app_err, "stderr", &line);
            }
        });
    }

    Ok(())
}

#[tauri::command]
pub async fn container_pull_image(app: tauri::AppHandle, image: String) -> Result<(), String> {
    let rt = get_runtime()?;
    let mut cmd = build_cmd(&rt);
    cmd.args(["pull", &image])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    let stderr = child.stderr.take();
    if let Some(stderr) = stderr {
        let app_err = app.clone();
        tokio::spawn(async move {
            let reader = tokio::io::BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                emit_output(&app_err, "stdout", &line);
            }
        });
    }

    let app_done = app.clone();
    tokio::spawn(async move {
        let status = child.wait().await;
        let code = status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
        let _ = app_done.emit(
            "container-output",
            ContainerOutputEvent {
                kind: "done".to_string(),
                text: format!("Pull completed with code {}", code),
                exit_code: Some(code),
            },
        );
    });

    Ok(())
}

#[tauri::command]
pub async fn container_exec(container_id: String, command: String) -> Result<String, String> {
    let rt = get_runtime()?;
    let mut cmd = build_cmd(&rt);
    cmd.args(["exec", &container_id, "sh", "-c", &command]);
    let output = cmd.output().await.map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// ─── Tauri Commands: DevContainer ────────────────────────────────────────────

#[tauri::command]
pub async fn devcontainer_detect(workspace_path: String) -> Result<bool, String> {
    let config_path = Path::new(&workspace_path)
        .join(".devcontainer")
        .join("devcontainer.json");
    Ok(config_path.exists())
}

#[tauri::command]
pub async fn devcontainer_load_config(
    workspace_path: String,
) -> Result<DevContainerConfig, String> {
    let config_path = Path::new(&workspace_path)
        .join(".devcontainer")
        .join("devcontainer.json");
    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read devcontainer.json: {}", e))?;
    // Strip JSON comments (// and /* */) before parsing
    let stripped = strip_json_comments(&content);
    let config: DevContainerConfig =
        serde_json::from_str(&stripped).map_err(|e| format!("Invalid devcontainer.json: {}", e))?;
    Ok(config)
}

fn strip_json_comments(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut in_string = false;

    while let Some(&ch) = chars.peek() {
        if in_string {
            result.push(ch);
            chars.next();
            if ch == '\\' {
                if let Some(&next) = chars.peek() {
                    result.push(next);
                    chars.next();
                }
            } else if ch == '"' {
                in_string = false;
            }
        } else if ch == '"' {
            in_string = true;
            result.push(ch);
            chars.next();
        } else if ch == '/' {
            chars.next();
            match chars.peek() {
                Some(&'/') => {
                    // Line comment — skip until newline
                    while let Some(&c) = chars.peek() {
                        chars.next();
                        if c == '\n' {
                            result.push('\n');
                            break;
                        }
                    }
                }
                Some(&'*') => {
                    // Block comment — skip until */
                    chars.next();
                    loop {
                        match chars.next() {
                            Some('*') if chars.peek() == Some(&'/') => {
                                chars.next();
                                break;
                            }
                            Some('\n') => result.push('\n'),
                            None => break,
                            _ => {}
                        }
                    }
                }
                _ => {
                    result.push('/');
                }
            }
        } else {
            result.push(ch);
            chars.next();
        }
    }
    result
}

/// Every command a devcontainer config would execute, in the order it runs.
///
/// `initializeCommand` is the one that matters: it runs on the **host**, so a
/// `devcontainer.json` from an untrusted repo can execute arbitrary shell on the
/// user's machine the moment they click "start dev container".
pub fn lifecycle_commands(config: &DevContainerConfig) -> Vec<crate::trust::LifecycleCommand> {
    let mut out = Vec::new();

    let mut push = |phase: &str, cmd: &Option<StringOrArray>, runs_on_host: bool| {
        if let Some(value) = cmd {
            let command = value.to_shell_command();
            if !command.trim().is_empty() {
                out.push(crate::trust::LifecycleCommand {
                    phase: phase.to_string(),
                    command,
                    runs_on_host,
                });
            }
        }
    };

    push("initializeCommand", &config.initialize_command, true);
    push("onCreateCommand", &config.on_create_command, false);
    push(
        "updateContentCommand",
        &config.update_content_command,
        false,
    );
    push("postCreateCommand", &config.post_create_command, false);
    push("postStartCommand", &config.post_start_command, false);
    push("postAttachCommand", &config.post_attach_command, false);

    out
}

/// What would run for this workspace, and whether the user has already approved it.
#[tauri::command]
pub async fn devcontainer_trust_status(
    workspace_path: String,
) -> Result<crate::trust::TrustStatus, String> {
    let config = devcontainer_load_config(workspace_path.clone()).await?;
    let commands = lifecycle_commands(&config);
    Ok(crate::trust::TrustStatus {
        trusted: crate::trust::is_trusted(&workspace_path, &commands),
        has_host_commands: commands.iter().any(|c| c.runs_on_host),
        commands,
    })
}

/// Record the user's approval of this workspace's current lifecycle commands.
#[tauri::command]
pub async fn devcontainer_trust_grant(workspace_path: String) -> Result<(), String> {
    let config = devcontainer_load_config(workspace_path.clone()).await?;
    let commands = lifecycle_commands(&config);
    crate::trust::grant(&workspace_path, &commands)
}

#[tauri::command]
pub fn devcontainer_trust_revoke(workspace_path: String) -> Result<(), String> {
    crate::trust::revoke(&workspace_path)
}

#[tauri::command]
pub async fn devcontainer_up(
    app: tauri::AppHandle,
    workspace_path: String,
    display_forwarding: bool,
    gpu_passthrough: bool,
    selinux_label: bool,
    persist_julia_packages: bool,
) -> Result<(), String> {
    let config = devcontainer_load_config(workspace_path.clone()).await?;

    // Enforced here, not only in the UI: this command is reachable from the webview
    // (and from any plugin holding the `containers` permission), so the check has to
    // live on the side of the boundary that actually runs the commands.
    let commands = lifecycle_commands(&config);
    if !crate::trust::is_trusted(&workspace_path, &commands) {
        return Err(format!(
            "This workspace has not been trusted to run its devcontainer lifecycle commands. \
             {} command(s) are declared, {} of which would run on this machine rather than in the container. \
             Review them and approve the workspace before starting the dev container.",
            commands.len(),
            commands.iter().filter(|c| c.runs_on_host).count()
        ));
    }

    let rt = get_runtime()?;

    // Auto-detect SELinux if the setting is enabled
    let selinux = selinux_label && detect_selinux();

    emit_status(&app, "building", Some("Starting dev container..."), None);
    emit_output(&app, "status", "Starting dev container setup...");

    // 1. Run initializeCommand on host
    if let Some(ref init_cmd) = config.initialize_command {
        let cmd_str = init_cmd.to_shell_command();
        emit_output(
            &app,
            "status",
            &format!("Running initializeCommand: {}", cmd_str),
        );
        let output = tokio::process::Command::new("sh")
            .args(["-c", &cmd_str])
            .current_dir(&workspace_path)
            .output()
            .await
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr).to_string();
            emit_output(&app, "stderr", &err);
        }
    }

    // 2. Build or pull image
    let image_name: String;
    if let Some(ref build_cfg) = config.build {
        if let Some(ref dockerfile) = build_cfg.dockerfile {
            let devcontainer_dir = Path::new(&workspace_path).join(".devcontainer");
            let context = build_cfg.context.as_deref().unwrap_or(".");
            let context_path = devcontainer_dir.join(context);
            let dockerfile_path = devcontainer_dir.join(dockerfile);

            let workspace_name = Path::new(&workspace_path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            image_name = format!("julide-dev-{}", workspace_name);

            emit_output(
                &app,
                "status",
                &format!("Building image {} from {}...", image_name, dockerfile),
            );

            let mut build_cmd = build_cmd(&rt);
            build_cmd
                .arg("build")
                .arg("-t")
                .arg(&image_name)
                .arg("-f")
                .arg(dockerfile_path.to_string_lossy().to_string());

            if let Some(ref target) = build_cfg.target {
                build_cmd.arg("--target").arg(target);
            }
            if let Some(ref args) = build_cfg.args {
                for (k, v) in args {
                    build_cmd.arg("--build-arg").arg(format!("{}={}", k, v));
                }
            }
            if let Some(ref cache) = build_cfg.cache_from {
                for c in cache {
                    build_cmd.arg("--cache-from").arg(c);
                }
            }
            build_cmd.arg(context_path.to_string_lossy().to_string());
            build_cmd
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());

            let mut child = build_cmd
                .spawn()
                .map_err(|e| format!("Build failed: {}", e))?;
            let stderr = child.stderr.take();
            let stdout = child.stdout.take();

            if let Some(stdout) = stdout {
                let app_out = app.clone();
                tokio::spawn(async move {
                    let reader = tokio::io::BufReader::new(stdout);
                    let mut lines = reader.lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        emit_output(&app_out, "stdout", &line);
                    }
                });
            }
            if let Some(stderr) = stderr {
                let app_err = app.clone();
                tokio::spawn(async move {
                    let reader = tokio::io::BufReader::new(stderr);
                    let mut lines = reader.lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        emit_output(&app_err, "stderr", &line);
                    }
                });
            }

            let build_status = child.wait().await.map_err(|e| e.to_string())?;
            if !build_status.success() {
                emit_status(&app, "error", Some("Image build failed"), None);
                return Err("Image build failed".to_string());
            }
            emit_output(&app, "status", "Image built successfully.");
        } else {
            image_name = config
                .image
                .clone()
                .ok_or("No image or dockerfile specified")?;
        }
    } else if let Some(ref img) = config.image {
        image_name = img.clone();
        emit_output(&app, "status", &format!("Pulling image {}...", image_name));
        let mut pull_cmd = build_cmd(&rt);
        pull_cmd
            .args(["pull", &image_name])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = pull_cmd.spawn().map_err(|e| e.to_string())?;

        let stderr = child.stderr.take();
        if let Some(stderr) = stderr {
            let app_pull = app.clone();
            tokio::spawn(async move {
                let reader = tokio::io::BufReader::new(stderr);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    emit_output(&app_pull, "stdout", &line);
                }
            });
        }

        let pull_status = child.wait().await.map_err(|e| e.to_string())?;
        if !pull_status.success() {
            emit_output(
                &app,
                "stderr",
                &format!(
                    "Warning: pull failed, attempting to use cached image {}",
                    image_name
                ),
            );
        }
    } else {
        return Err(
            "devcontainer.json must specify either 'image' or 'build.dockerfile'".to_string(),
        );
    }

    // 3. Create container
    emit_status(&app, "starting", Some("Creating container..."), None);
    emit_output(&app, "status", "Creating container...");

    let workspace_name = Path::new(&workspace_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    let container_name = format!("julide-{}", workspace_name);
    let workspace_folder = config.workspace_folder.as_deref().unwrap_or("/workspace");

    // Remove existing container with same name if present
    let mut rm_cmd = build_cmd(&rt);
    rm_cmd.args(["rm", "-f", &container_name]);
    let _ = rm_cmd.output().await;

    let mut create_cmd = build_cmd(&rt);
    create_cmd
        .arg("create")
        .arg("-it")
        .arg("--name")
        .arg(&container_name);

    // Workspace mount (with SELinux :Z label if needed)
    let z = volume_suffix(selinux);
    if let Some(ref custom_mount) = config.workspace_mount {
        create_cmd.arg("--mount").arg(custom_mount);
    } else {
        create_cmd
            .arg("-v")
            .arg(format!("{}:{}:rw{}", workspace_path, workspace_folder, z));
    }
    create_cmd.arg("-w").arg(workspace_folder);

    // Julia package persistence: named volume for ~/.julia so packages survive container rebuilds
    if persist_julia_packages {
        let julia_vol_name = format!("julide-julia-pkgs-{}", workspace_name);
        let julia_home = if let Some(ref user) = config.remote_user {
            if user == "root" {
                "/root/.julia".to_string()
            } else {
                format!("/home/{}/.julia", user)
            }
        } else {
            "/root/.julia".to_string()
        };
        create_cmd
            .arg("-v")
            .arg(format!("{}:{}", julia_vol_name, julia_home));
    }

    // Environment variables
    if let Some(ref env_map) = config.container_env {
        for (k, v) in env_map {
            create_cmd.arg("--env").arg(format!("{}={}", k, v));
        }
    }

    // Mounts
    if let Some(ref mounts) = config.mounts {
        for mount in mounts {
            match mount {
                serde_json::Value::String(s) => {
                    create_cmd.arg("--mount").arg(s);
                }
                serde_json::Value::Object(obj) => {
                    // Convert object form to string: type=bind,source=...,target=...
                    let parts: Vec<String> = obj
                        .iter()
                        .map(|(k, v)| format!("{}={}", k, v.as_str().unwrap_or_default()))
                        .collect();
                    create_cmd.arg("--mount").arg(parts.join(","));
                }
                _ => {}
            }
        }
    }

    // Port forwarding
    if let Some(ref ports) = config.forward_ports {
        for port in ports {
            create_cmd.arg("-p").arg(format!("{}:{}", port, port));
        }
    }

    // User
    if let Some(ref user) = config.remote_user {
        create_cmd.arg("--user").arg(user);
    }

    // Security
    if let Some(ref caps) = config.cap_add {
        for cap in caps {
            create_cmd.arg("--cap-add").arg(cap);
        }
    }
    if let Some(ref opts) = config.security_opt {
        for opt in opts {
            create_cmd.arg("--security-opt").arg(opt);
        }
    }
    if config.privileged == Some(true) {
        create_cmd.arg("--privileged");
    }

    // Display forwarding
    if display_forwarding {
        for arg in get_display_forwarding_args() {
            create_cmd.arg(&arg);
        }
    }

    // GPU passthrough
    if gpu_passthrough {
        for arg in get_gpu_passthrough_args() {
            create_cmd.arg(&arg);
        }
    }

    // Extra runArgs
    if let Some(ref run_args) = config.run_args {
        for arg in run_args {
            create_cmd.arg(arg);
        }
    }

    // Image
    create_cmd.arg(&image_name);

    let create_output = create_cmd.output().await.map_err(|e| e.to_string())?;
    if !create_output.status.success() {
        let err = String::from_utf8_lossy(&create_output.stderr).to_string();
        emit_status(&app, "error", Some(&err), None);
        emit_output(&app, "stderr", &err);
        return Err(format!("Container creation failed: {}", err));
    }
    let container_id = String::from_utf8_lossy(&create_output.stdout)
        .trim()
        .to_string();
    emit_output(
        &app,
        "status",
        &format!("Container created: {}", container_id),
    );

    // 4. Start container
    let mut start_cmd = build_cmd(&rt);
    start_cmd.args(["start", &container_id]);
    let start_out = start_cmd.output().await.map_err(|e| e.to_string())?;
    if !start_out.status.success() {
        let err = String::from_utf8_lossy(&start_out.stderr).to_string();
        emit_status(&app, "error", Some(&err), Some(&container_id));
        return Err(format!("Container start failed: {}", err));
    }
    emit_output(&app, "status", "Container started.");

    // 5. Run lifecycle commands
    let lifecycle_commands: Vec<(&str, &Option<StringOrArray>)> = vec![
        ("onCreateCommand", &config.on_create_command),
        ("updateContentCommand", &config.update_content_command),
        ("postCreateCommand", &config.post_create_command),
        ("postStartCommand", &config.post_start_command),
    ];

    for (name, cmd_opt) in lifecycle_commands {
        if let Some(ref cmd_val) = cmd_opt {
            let cmd_str = cmd_val.to_shell_command();
            emit_output(&app, "status", &format!("Running {}: {}", name, cmd_str));
            let mut exec_cmd = build_cmd(&rt);
            exec_cmd.args(["exec", &container_id, "sh", "-c", &cmd_str]);
            let exec_out = exec_cmd.output().await.map_err(|e| e.to_string())?;
            if !exec_out.status.success() {
                let err = String::from_utf8_lossy(&exec_out.stderr).to_string();
                emit_output(&app, "stderr", &format!("{} failed: {}", name, err));
            } else {
                let out = String::from_utf8_lossy(&exec_out.stdout).to_string();
                if !out.trim().is_empty() {
                    emit_output(&app, "stdout", &out);
                }
            }
        }
    }

    // 6. Update state
    {
        let mut state = CONTAINER_STATE.lock_recover();
        state.active_container_id = Some(container_id.clone());
        state.active_container_name = Some(container_name.clone());
        state.container_state = ContainerState::Running;
    }

    emit_status(&app, "running", Some(&container_name), Some(&container_id));
    emit_output(
        &app,
        "status",
        &format!("Dev container '{}' is ready.", container_name),
    );

    Ok(())
}

#[tauri::command]
pub async fn devcontainer_stop(app: tauri::AppHandle) -> Result<(), String> {
    let container_id = {
        let state = CONTAINER_STATE.lock_recover();
        state
            .active_container_id
            .clone()
            .ok_or_else(|| "No active dev container".to_string())?
    };
    container_stop(app.clone(), container_id).await?;
    {
        let mut state = CONTAINER_STATE.lock_recover();
        state.container_state = ContainerState::Stopped;
    }
    emit_status(&app, "stopped", None, None);
    Ok(())
}

#[tauri::command]
pub async fn devcontainer_rebuild(
    app: tauri::AppHandle,
    workspace_path: String,
    display_forwarding: bool,
    gpu_passthrough: bool,
    selinux_label: bool,
    persist_julia_packages: bool,
) -> Result<(), String> {
    // Stop and remove existing container
    let existing_id = {
        let state = CONTAINER_STATE.lock_recover();
        state.active_container_id.clone()
    };
    if let Some(id) = existing_id {
        let rt = get_runtime()?;
        let mut cmd = build_cmd(&rt);
        cmd.args(["rm", "-f", &id]);
        let _ = cmd.output().await;
    }
    {
        let mut state = CONTAINER_STATE.lock_recover();
        state.active_container_id = None;
        state.active_container_name = None;
        state.container_state = ContainerState::None;
    }
    emit_output(&app, "status", "Rebuilding dev container...");
    devcontainer_up(
        app,
        workspace_path,
        display_forwarding,
        gpu_passthrough,
        selinux_label,
        persist_julia_packages,
    )
    .await
}

#[tauri::command]
pub async fn devcontainer_down(app: tauri::AppHandle) -> Result<(), String> {
    let container_id = {
        let state = CONTAINER_STATE.lock_recover();
        state.active_container_id.clone()
    };
    if let Some(ref id) = container_id {
        if let Ok(rt) = get_runtime() {
            let mut stop_cmd = build_cmd(&rt);
            stop_cmd.args(["stop", id]);
            let _ = stop_cmd.output().await;
            let mut rm_cmd = build_cmd(&rt);
            rm_cmd.args(["rm", "-f", id]);
            let _ = rm_cmd.output().await;
        }
    }
    {
        let mut state = CONTAINER_STATE.lock_recover();
        state.active_container_id = None;
        state.active_container_name = None;
        state.container_state = ContainerState::None;
    }
    emit_status(&app, "none", Some("Dev container removed"), None);
    Ok(())
}

// ─── Container PTY ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn container_pty_create(
    app: tauri::AppHandle,
    session_id: String,
    container_id: String,
    command: Option<String>,
    working_dir: Option<String>,
) -> Result<bool, String> {
    if crate::pty::session_exists(&session_id) {
        return Ok(false);
    }

    let rt = get_runtime()?;

    let pty_system = portable_pty::native_pty_system();
    let pair = pty_system
        .openpty(portable_pty::PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = command.as_deref().unwrap_or("/bin/bash");

    // Build: docker exec -it <container_id> <shell>
    let mut cmd = portable_pty::CommandBuilder::new(&rt.binary_path);
    if let Some(ref host) = rt.remote_host {
        match rt.kind {
            ContainerRuntimeKind::Docker => {
                cmd.arg("-H");
                cmd.arg(host);
            }
            ContainerRuntimeKind::Podman => {
                cmd.arg("--remote");
                cmd.arg("--url");
                cmd.arg(host);
            }
        }
    }
    cmd.arg("exec");
    cmd.arg("-it");
    if let Some(ref wd) = working_dir {
        cmd.arg("-w");
        cmd.arg(wd);
    }
    cmd.arg(&container_id);
    cmd.arg(shell);

    cmd.env("TERM", "xterm-256color");
    if let Ok(home) = std::env::var("HOME") {
        cmd.env("HOME", &home);
    }

    let _child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;

    crate::pty::register_session(&app, &session_id, pair.master)?;

    Ok(true)
}

// ─── Container Julia Run ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn container_julia_run(
    app: tauri::AppHandle,
    container_id: String,
    file_path: String,
    project_path: Option<String>,
) -> Result<(), String> {
    let rt = get_runtime()?;

    let mut cmd = build_cmd(&rt);
    cmd.arg("exec").arg(&container_id).arg("julia");
    if let Some(ref proj) = project_path {
        cmd.arg(format!("--project={}", proj));
    }
    cmd.arg(&file_path);
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to run Julia in container: {}", e))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    if let Some(stdout) = stdout {
        let app_out = app.clone();
        tokio::spawn(async move {
            let reader = tokio::io::BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_out.emit(
                    "julia-output",
                    crate::julia::JuliaOutputEvent {
                        kind: "stdout".into(),
                        text: crate::julia::normalize_julia_stdio_line(line),
                        exit_code: None,
                    },
                );
            }
        });
    }

    if let Some(stderr) = stderr {
        let app_err = app.clone();
        tokio::spawn(async move {
            let reader = tokio::io::BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = app_err.emit(
                    "julia-output",
                    crate::julia::JuliaOutputEvent {
                        kind: "stderr".into(),
                        text: crate::julia::normalize_julia_stdio_line(line),
                        exit_code: None,
                    },
                );
            }
        });
    }

    let app_done = app.clone();
    tokio::spawn(async move {
        let status = child.wait().await;
        let code = status.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
        let _ = app_done.emit(
            "julia-output",
            crate::julia::JuliaOutputEvent {
                kind: "done".into(),
                text: String::new(),
                exit_code: Some(code),
            },
        );
    });

    Ok(())
}
