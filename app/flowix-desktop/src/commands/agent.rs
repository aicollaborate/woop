//! Agent IPC —LLM 流式 chat + abort�?//!
//! Agent 的配�?��源是 `~/.flowix/agent-config.toml` (�?`set_ai_config` 命令落盘)�?//! 后�?按需�?`UserConfigStore` 拉取并在 `AgentManager` 里缓�?provider 实例,
//! 前�?不再 init agent / 提交模型信息, �?���?chat / thread 操作�?
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};

use async_trait::async_trait;
use base64::Engine;
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::agent_external::runtime_registry::ExternalCliRuntime;
use crate::agent_external_config::{AgentExternalEntry, AgentExternalSource};
use crate::agent_flowix::{AgentChatResponse, AgentManager, AgentUserMessage, RunInfo};
use crate::agent_session::AgentExternalEvent;

use crate::app::state::AppState;

const MAX_AGENT_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const MAX_AGENT_IMAGE_COUNT: usize = 5;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedAgentImage {
    path: String,
    mime_type: String,
    name: String,
}

fn agent_image_extension(mime_type: &str) -> Option<&'static str> {
    match mime_type.trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

fn agent_image_cache_root() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".flowix").join("cache").join("images"))
        .ok_or_else(|| "Home directory is unavailable".to_string())
}

fn ensure_path_within_image_cache(root: &Path, candidate: &Path) -> Result<(), String> {
    if !candidate.starts_with(root) || !candidate.is_file() {
        return Err("Cached image path is outside the image cache".to_string());
    }
    Ok(())
}

async fn resolve_cached_agent_image(path: &str) -> Result<Option<PathBuf>, String> {
    let root = agent_image_cache_root()?;
    let root = match tokio::fs::canonicalize(&root).await {
        Ok(root) => root,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Failed to resolve image cache: {error}")),
    };
    let candidate = match tokio::fs::canonicalize(path).await {
        Ok(candidate) => candidate,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Failed to resolve cached image: {error}")),
    };
    ensure_path_within_image_cache(&root, &candidate)?;
    Ok(Some(candidate))
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn cache_agent_image(
    content: String,
    mimeType: String,
) -> Result<CachedAgentImage, String> {
    let extension = agent_image_extension(&mimeType)
        .ok_or_else(|| format!("Unsupported image type: {mimeType}"))?;
    let encoded = content
        .split_once(',')
        .map(|(_, body)| body)
        .unwrap_or(content.as_str());
    // Reject oversized payloads before allocating the decoded buffer. Base64
    // expands binary data by roughly 4/3; the small allowance covers padding.
    if encoded.len() > (MAX_AGENT_IMAGE_BYTES * 4 / 3) + 4 {
        return Err(format!(
            "Image exceeds {} MB limit",
            MAX_AGENT_IMAGE_BYTES / 1024 / 1024
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "Invalid base64 image content".to_string())?;
    if bytes.is_empty() {
        return Err("Image content is empty".to_string());
    }
    if bytes.len() > MAX_AGENT_IMAGE_BYTES {
        return Err(format!(
            "Image exceeds {} MB limit",
            MAX_AGENT_IMAGE_BYTES / 1024 / 1024
        ));
    }

    let directory =
        agent_image_cache_root()?.join(chrono::Local::now().format("%Y-%m-%d").to_string());
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|error| format!("Failed to create image cache: {error}"))?;
    let name = format!("{}.{}", Uuid::new_v4(), extension);
    let path = directory.join(&name);
    tokio::fs::write(&path, bytes)
        .await
        .map_err(|error| format!("Failed to cache image: {error}"))?;

    Ok(CachedAgentImage {
        path: path.to_string_lossy().into_owned(),
        mime_type: mimeType.to_ascii_lowercase(),
        name,
    })
}

#[tauri::command]
pub async fn delete_cached_agent_image(path: String) -> Result<bool, String> {
    let Some(candidate) = resolve_cached_agent_image(&path).await? else {
        return Ok(false);
    };
    tokio::fs::remove_file(candidate)
        .await
        .map(|_| true)
        .map_err(|error| format!("Failed to delete cached image: {error}"))
}

#[tauri::command]
pub async fn read_cached_agent_image(path: String) -> Result<Option<String>, String> {
    let Some(candidate) = resolve_cached_agent_image(&path).await? else {
        return Ok(None);
    };
    let mime_type = match candidate
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => return Err("Unsupported cached image type".to_string()),
    };
    let bytes = tokio::fs::read(candidate)
        .await
        .map_err(|error| format!("Failed to read cached image: {error}"))?;
    if bytes.len() > MAX_AGENT_IMAGE_BYTES {
        return Err("Cached image exceeds the preview size limit".to_string());
    }
    Ok(Some(format!(
        "data:{mime_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AgentRuntime {
    Flowix,
    Codex,
    Claude,
    Gemini,
    Hermes,
    OpenClaw,
}

impl AgentRuntime {
    fn from_agent_type(agent_type: Option<&str>) -> Self {
        match agent_type
            .unwrap_or("flowix")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "codex" => Self::Codex,
            "claude" => Self::Claude,
            "gemini" => Self::Gemini,
            "hermes" => Self::Hermes,
            "openclaw" => Self::OpenClaw,
            _ => Self::Flowix,
        }
    }

    fn from_message(message: &AgentUserMessage) -> Self {
        Self::from_agent_type(message.agent_type.as_deref())
    }

    fn key(self) -> &'static str {
        match self {
            Self::Flowix => "flowix",
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Gemini => "gemini",
            Self::Hermes => "hermes",
            Self::OpenClaw => "openclaw",
        }
    }
}

enum RuntimeHandle<'a> {
    Flowix(&'a Arc<AgentManager>),
    External(&'a dyn ExternalCliRuntime),
}

#[async_trait]
trait ChatRuntime {
    async fn chat_stream(
        &self,
        thread_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<String, String>;
    async fn stop_chat(
        &self,
        thread_id: &str,
        run_id: Option<&str>,
        app_handle: &tauri::AppHandle,
    ) -> bool;
}

#[async_trait]
impl ChatRuntime for RuntimeHandle<'_> {
    async fn chat_stream(
        &self,
        thread_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<String, String> {
        match self {
            Self::Flowix(manager) => manager
                .chat_stream(thread_id, message, app_handle)
                .await
                .map_err(|e| e.to_string()),
            Self::External(runtime) => runtime.chat_stream(thread_id, message, app_handle).await,
        }
    }

    async fn stop_chat(
        &self,
        thread_id: &str,
        run_id: Option<&str>,
        app_handle: &tauri::AppHandle,
    ) -> bool {
        match self {
            // Flowix 鍐呴儴 agent 鑷甫 cancel token + select!, stop 淇″彿鑳借娴佸紡
            // 任务即时响应, 不需要这里补�?StreamEnd, 故不�?app_handle�?
            Self::Flowix(manager) => manager.stop_chat(thread_id, run_id).await,
            Self::External(runtime) => runtime.stop_chat(thread_id, run_id, app_handle).await,
        }
    }
}

fn runtime_handle<'a>(state: &'a AppState, runtime: AgentRuntime) -> RuntimeHandle<'a> {
    match runtime {
        AgentRuntime::Flowix => RuntimeHandle::Flowix(&state.agent_manager),
        external => RuntimeHandle::External(
            state
                .external_runtimes
                .get(external.key())
                .expect("every external AgentRuntime must be registered"),
        ),
    }
}

async fn stop_any_runtime_chat(
    thread_id: &str,
    state: &AppState,
    app_handle: &tauri::AppHandle,
) -> bool {
    let (flowix, external) = tokio::join!(
        state.agent_manager.stop_chat(thread_id, None),
        state.external_runtimes.stop_chat_all(thread_id, app_handle),
    );
    flowix || external
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeAvailability {
    available: bool,
    reason: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeStatus {
    flowix: AgentRuntimeAvailability,
    codex: AgentRuntimeAvailability,
    claude: AgentRuntimeAvailability,
    gemini: AgentRuntimeAvailability,
    hermes: AgentRuntimeAvailability,
    openclaw: AgentRuntimeAvailability,
}

fn executable_available(path: &Path) -> bool {
    if path.is_file() {
        return true;
    }

    if path.components().count() != 1 {
        return false;
    }

    std::env::var_os("PATH")
        .map(|path_var| std::env::split_paths(&path_var).any(|dir| dir.join(path).is_file()))
        .unwrap_or(false)
}

/// 基于 `agent-external-config` 里�?录的 path 算单�?external agent 的可用性�?/// `path = None` -> �?���?(�?��探测没探�?; `path = Some` 但失�?-> not found;
/// �?�� -> `None` (调用方再叠加 preflight 错�?, �?codex �?Node 依赖)�?
fn external_availability(entry: AgentExternalEntry, label: &str) -> AgentRuntimeAvailability {
    let available = entry
        .path
        .as_ref()
        .map(|p| executable_available(p))
        .unwrap_or(false);
    let reason = match &entry.path {
        None => Some(format!(
            "{label} not configured (click Redetect in preferences)"
        )),
        Some(p) if !available => Some(format!("{label} not found ({})", p.display())),
        Some(_) => None,
    };
    AgentRuntimeAvailability { available, reason }
}

#[tauri::command]
pub fn agent_runtime_status(state: State<'_, AppState>) -> AgentRuntimeStatus {
    let ai_config = state.user_config.get_ai_config().model;
    let flowix_available = !ai_config.model.trim().is_empty();

    // The external CLI path comes from agent-external-config.json. Runtime
    // preflight can still add dependency details without hiding the entry.
    let cfg = &state.agent_external_config;
    let mut codex = external_availability(cfg.get_entry("codex"), "Codex CLI");
    if codex.available {
        codex.reason = crate::agent_external::codex::cli::preflight_codex().err();
    }
    let claude = external_availability(cfg.get_entry("claude"), "Claude Code CLI");
    let gemini = external_availability(cfg.get_entry("gemini"), "Gemini CLI");
    let hermes = external_availability(cfg.get_entry("hermes"), "Hermes Agent CLI");
    let openclaw = external_availability(cfg.get_entry("openclaw"), "OpenClaw CLI");

    AgentRuntimeStatus {
        flowix: AgentRuntimeAvailability {
            available: flowix_available,
            reason: (!flowix_available).then(|| "Flowix model is not configured".to_string()),
        },
        codex,
        claude,
        gemini,
        hermes,
        openclaw,
    }
}

/// 偏好设置展示用的 external agent 条目视图�?
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentExternalEntryView {
    pub path: Option<String>,
    pub source: AgentExternalSource,
    pub available: bool,
}

impl AgentExternalEntryView {
    fn from_entry(entry: AgentExternalEntry) -> Self {
        let available = entry
            .path
            .as_ref()
            .map(|p| executable_available(p))
            .unwrap_or(false);
        Self {
            path: entry.path.map(|p| p.to_string_lossy().to_string()),
            source: entry.source,
            available,
        }
    }
}

/// 读取全部 external agent 的路径配�?(供偏好�?�?���?�?
#[tauri::command]
pub fn get_agent_external_config(
    state: State<'_, AppState>,
) -> HashMap<String, AgentExternalEntryView> {
    state
        .agent_external_config
        .snapshot()
        .into_iter()
        .map(|(k, e)| (k, AgentExternalEntryView::from_entry(e)))
        .collect()
}

/// 用户手改 path: �?`source = user` 并同步注册表�?
#[tauri::command]
pub fn set_agent_external_path(
    agent_type: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<AgentExternalEntryView, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("path must not be empty".to_string());
    }
    let path_buf = PathBuf::from(trimmed);
    // 校验: 必须�?��实存在的�?��行文�?── 拒绝�?��/文档/无执行权限的文件,
    // 避免把无效路径写�?agent-external-config.json 导致后续 spawn 失败�?
    if !crate::agent_external::cli_resolver::is_executable_file(&path_buf) {
        return Err(format!(
            "not a valid executable file: {}",
            path_buf.display()
        ));
    }
    let entry = state
        .agent_external_config
        .set_user_path(&agent_type, path_buf)
        .map_err(|e| e.to_string())?;
    Ok(AgentExternalEntryView::from_entry(entry))
}

/// 重新探测单个 agent: 清注册表该项 -> 跑探测链 -> �?`source = auto` -> 回填注册表�?
#[tauri::command]
pub fn redetect_agent_external(
    agent_type: String,
    state: State<'_, AppState>,
) -> Result<AgentExternalEntryView, String> {
    state
        .agent_external_config
        .redetect(&agent_type)
        .map_err(|e| e.to_string())?;
    Ok(AgentExternalEntryView::from_entry(
        state.agent_external_config.get_entry(&agent_type),
    ))
}

/// 打开文件浏�?器�?用户选一�?CLI �?��行文�? 返回其绝对路径�?/// 供偏好�?�?切换"按钮调用 ── �?���?��通过文件选择器指�? 不允许手输�?
#[tauri::command]
pub async fn select_external_cli_path(app: tauri::AppHandle) -> Option<String> {
    use std::sync::mpsc;
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = mpsc::channel();
    let handle = app.clone();
    tokio::task::spawn_blocking(move || {
        let result = handle
            .dialog()
            .file()
            .set_title("Select CLI executable")
            .blocking_pick_file()
            .map(|p| p.to_string());
        tx.send(result).ok();
    });
    rx.recv().ok().flatten()
}

#[cfg(target_os = "windows")]
const CODEX_INSTALL_COMMAND: &str =
    "npm.cmd install -g @openai/codex@latest --force --include=optional";

#[cfg(not(target_os = "windows"))]
const CODEX_INSTALL_COMMAND: &str =
    "npm install -g @openai/codex@latest --force --include=optional";

#[tauri::command]
pub fn open_codex_cli_install_terminal() -> Result<(), String> {
    open_terminal_with_command(CODEX_INSTALL_COMMAND)
}

#[tauri::command]
pub fn open_codex_config() -> Result<(), String> {
    let home =
        dirs::home_dir().ok_or_else(|| "Could not resolve the home directory".to_string())?;
    let config_dir = home.join(".codex");
    let config_path = config_dir.join("config.toml");
    std::fs::create_dir_all(&config_dir).map_err(|err| err.to_string())?;
    if !config_path.exists() {
        std::fs::write(
            &config_path,
            "# Codex CLI configuration\n# Add custom model settings here.\n",
        )
        .map_err(|err| err.to_string())?;
    }
    open_config_file(&config_path)
}

#[cfg(target_os = "windows")]
fn open_terminal_with_command(command: &str) -> Result<(), String> {
    Command::new("powershell.exe")
        .args([
            "-NoExit",
            "-Command",
            &format!("{command}; Write-Host ''; Write-Host 'Codex CLI install command finished.'"),
        ])
        .spawn()
        .map(|_| ())
        .map_err(|err| err.to_string())
}

#[cfg(target_os = "windows")]
fn open_config_file(path: &Path) -> Result<(), String> {
    Command::new("notepad.exe")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|err| err.to_string())
}

#[cfg(target_os = "macos")]
fn open_terminal_with_command(command: &str) -> Result<(), String> {
    Command::new("osascript")
        .args([
            "-e",
            &format!(
                "tell application \"Terminal\" to do script \"{}\"",
                escape_applescript(command)
            ),
            "-e",
            "tell application \"Terminal\" to activate",
        ])
        .spawn()
        .map(|_| ())
        .map_err(|err| err.to_string())
}

#[cfg(target_os = "macos")]
fn escape_applescript(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "macos")]
fn open_config_file(path: &Path) -> Result<(), String> {
    Command::new("open")
        .args(["-t"])
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|err| err.to_string())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_terminal_with_command(command: &str) -> Result<(), String> {
    let shell_command = format!("{command}; echo; read -r -p 'Press Enter to close...'");
    let candidates: &[(&str, &[&str])] = &[
        ("x-terminal-emulator", &["-e", "sh", "-lc"]),
        ("gnome-terminal", &["--", "sh", "-lc"]),
        ("konsole", &["-e", "sh", "-lc"]),
        ("xfce4-terminal", &["-e", "sh -lc"]),
        ("xterm", &["-e", "sh", "-lc"]),
    ];

    for (program, args) in candidates {
        let mut cmd = Command::new(program);
        cmd.args(*args);
        cmd.arg(&shell_command);
        if cmd.spawn().is_ok() {
            return Ok(());
        }
    }
    Err("Could not find a supported terminal application".to_string())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_config_file(path: &Path) -> Result<(), String> {
    Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|err| err.to_string())
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn chat_with_agent_stream(
    threadId: String,
    mut message: AgentUserMessage,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<AgentChatResponse, String> {
    let runtime = AgentRuntime::from_message(&message);
    if message.image_paths.len() > MAX_AGENT_IMAGE_COUNT {
        return Err(format!(
            "A message can attach at most {MAX_AGENT_IMAGE_COUNT} images"
        ));
    }
    let mut validated_image_paths = Vec::with_capacity(message.image_paths.len());
    for raw in std::mem::take(&mut message.image_paths) {
        let Some(path) = resolve_cached_agent_image(&raw).await? else {
            continue;
        };
        let metadata = tokio::fs::metadata(&path)
            .await
            .map_err(|error| format!("Failed to inspect cached image: {error}"))?;
        if metadata.len() > MAX_AGENT_IMAGE_BYTES as u64 {
            return Err(format!(
                "Image exceeds {} MB limit",
                MAX_AGENT_IMAGE_BYTES / 1024 / 1024
            ));
        }
        validated_image_paths.push(path.to_string_lossy().into_owned());
    }
    message.image_paths = validated_image_paths;
    if !message.image_paths.is_empty() && matches!(runtime, AgentRuntime::Flowix) {
        let mut llm_content = message
            .llm_content
            .clone()
            .unwrap_or_else(|| message.content.clone());
        for (index, path) in message.image_paths.iter().enumerate() {
            llm_content.push_str(&format!("\n\n![attached image {}]({})", index + 1, path));
        }
        message.llm_content = Some(llm_content);
    }
    tracing::info!(
        "[Command] chat_with_agent_stream called for thread: {}, agent_type: {}",
        threadId,
        runtime.key()
    );

    if let Some(title) = message
        .conversation_title
        .as_deref()
        .map(|value| value.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|value| !value.is_empty())
    {
        let manager = &state.thread_manager;
        manager
            .update_title(
                &threadId,
                title,
                crate::agent_types::AgentId::new(runtime.key()),
            )
            .await
            .map_err(|error| error.to_string())?;
    }

    // Refresh security-scoped access at every run, not only at startup. Start
    // access before validating because a macOS bookmark may be what makes the
    // directory visible to this process. Explicit runtime paths must never
    // silently fall back to the application cwd when a frozen path disappears.
    let runtime_cwd = message
        .cwd_for_runtime(runtime.key())
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_string);
    let runtime_workspace_paths = message.workspace_paths_for_runtime(runtime.key());
    if let Some(path) = runtime_cwd.as_deref() {
        state
            .security_bookmarks
            .start_accessing_for_path(Path::new(path));
    }
    for path in &runtime_workspace_paths {
        state
            .security_bookmarks
            .start_accessing_for_path(Path::new(path));
    }
    if let Some(path) = runtime_cwd.as_deref() {
        if !Path::new(path).is_dir() {
            return Err(format!("Agent working directory is unavailable: {path}"));
        }
    }
    for path in &runtime_workspace_paths {
        if !Path::new(path).is_dir() {
            return Err(format!("Agent workspace directory is unavailable: {path}"));
        }
    }

    // `agent_manager` �?`Arc<AgentManager>`, `chat_stream` 内部已经
    // `tokio::spawn` ── IPC 立即返回, 不再 await 整个 stream 跑完�?    // 真�?的助手回答通过 `agent-chunk` 事件 (`Text` / `Reasoning` 变体)
    // 推到前�?, �?`thread_id` 派发�?`threadStates[tid]`�?    //
    // Tauri IPC 边界仍�?�?`Result<T, String>` ── `AgentError` 在�?
    // `.map_err(|e| e.to_string())` 透传。当�?spawn 后不会走�?Err 分支
    // (错�?信号已全部走 `Error` chunk), 但保�?Result 形状不破 IPC 契约�?
    let result = runtime_handle(&state, runtime)
        .chat_stream(&threadId, message, &app_handle)
        .await;
    tracing::info!(
        "[Command] {} chat_with_agent_stream result: {:?}",
        runtime.key(),
        result.is_ok()
    );
    result.map(|response| AgentChatResponse { response })
}

/// Frontend-initiated abort for an in-flight `chat_with_agent_stream`.
/// Returns `true` if a chat was actually running for this `threadId` and
/// got a cancel signal; `false` if there was nothing to cancel (e.g. user
/// clicked stop after the LLM had already finished, or never sent a
/// message). The frontend uses the boolean to decide whether to also
/// hide the stop button / show a toast 鈥?a `false` return is harmless.
///
/// `runId` (optional) scopes the kill to a single in-flight run on the
/// thread. When `None` / unmatched, the manager falls back to a thread-wide
/// stop so legacy callers (and the `thread_delete` cleanup path that
/// doesn't track runs) keep working unchanged.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn stop_agent_stream(
    threadId: String,
    agentType: Option<String>,
    runId: Option<String>,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<bool, String> {
    let runtime = agentType
        .as_deref()
        .map(|agent_type| AgentRuntime::from_agent_type(Some(agent_type)));
    tracing::info!(
        "[Command] stop_agent_stream called for thread: {}, agent_type: {}, run_id: {}",
        threadId,
        runtime.map(AgentRuntime::key).unwrap_or("unknown"),
        runId.as_deref().unwrap_or("<any>")
    );
    let signalled = match runtime {
        Some(runtime) => {
            runtime_handle(&state, runtime)
                .stop_chat(&threadId, run_id_for_kill(runId.as_deref()), &app_handle)
                .await
        }
        None => stop_any_runtime_chat(&threadId, &state, &app_handle).await,
    };
    tracing::info!(
        "[Command] stop_agent_stream result: {} (chat was {}running)",
        threadId,
        if signalled { "" } else { "not " }
    );
    Ok(signalled)
}

fn run_id_for_kill(provided: Option<&str>) -> Option<&str> {
    provided.map(str::trim).filter(|value| !value.is_empty())
}

/// 查�?当前所�?in-flight chat ── 前�?�?��时调一�? seed
/// `threadStates[].isLoading`, �?进程内已有后台跑 chat"在重�?��
/// 仍然�??。返�?`HashMap<thread_id, RunInfo>`; �?map 表示当前
/// 没有 in-flight chat (稳�?�?///
/// 进程退�?in-flight chat �?���? 这是"�?�?信息; A5 �?��清理
/// 兜底 `is_loading=1` �?SQLite 残留�? 二者组合保�?UI 状态一致�?
#[tauri::command]
#[allow(non_snake_case)]
pub async fn agent_running_threads(
    state: State<'_, AppState>,
) -> Result<HashMap<String, RunInfo>, String> {
    let (mut running, external) = tokio::join!(
        state.agent_manager.running_threads(),
        state.external_runtimes.running_threads(),
    );
    running.extend(external);
    Ok(running)
}

#[tauri::command]
#[allow(non_snake_case)]
pub async fn agent_external_events(
    threadId: String,
    afterId: Option<i64>,
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<AgentExternalEvent>, String> {
    let manager = &state.thread_manager;
    let mut product_thread_id = threadId.clone();
    for runtime in state.external_runtimes.iter().map(ExternalCliRuntime::key) {
        if let Ok(Some(local_thread_id)) = manager
            .find_thread_by_external_session(&threadId, runtime)
            .await
        {
            product_thread_id = local_thread_id;
            break;
        }
    }
    let page_limit = limit.unwrap_or(1000).clamp(1, 1000);
    manager
        .list_agent_external_events_by_thread(&product_thread_id, afterId, page_limit)
        .await
        .map_err(|error| error.to_string())
}

// 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
// Codex 妯″瀷鍒楄〃 / 榛樿妯″瀷
//
// 这两�?IPC 命令原本放在 `commands/thread.rs`, 但�?义上属于 agent 配置,
// �?`agent.*` 命名空间对齐�?��这里。命令名 (codex_default_model /
// agent_supported_models) 与前�?invoke 不变�?// ─────────────────────────────────────────────────────────────────────────

/// 返回 Codex 默�? model id, 优先�?
///   1. `~/.codex/config.toml` 椤跺眰 `model = "..."`;
///   2. `codex debug models` 列表�?���?
///   3. 兜底�?���?`"gpt-5.5"`�?/// 仅用于前�?UI label 显示; 真�?运�? Codex �?`model == "inherit"` / �?/// 会走 `codex_cli::normalized_codex_model` 不传 `-m`�?
#[tauri::command]
pub async fn codex_default_model() -> Result<String, String> {
    if let Some(model) = read_codex_config_model() {
        return Ok(model);
    }

    if let Some(model) = query_codex_models().await?.first().cloned() {
        return Ok(model);
    }

    Ok("gpt-5.5".to_string())
}

/// �?agent type 返回后�?�?���?model id 列表。当前只�?`codex` 走动�?/// 查�? (�?�� `codex debug models`); 其余 type 返回�?── 前�?会回落到
/// 纭紪鐮?fallback (CODEX_MODEL_OPTIONS / CLAUDE_MODEL_OPTIONS)銆?
#[tauri::command]
pub async fn agent_supported_models(agent_type: String) -> Result<Vec<String>, String> {
    match agent_type.trim().to_ascii_lowercase().as_str() {
        "codex" => query_codex_models().await,
        _ => Ok(Vec::new()),
    }
}

async fn query_codex_models() -> Result<Vec<String>, String> {
    let mut cmd = crate::agent_external::codex::cli::build_codex_entrypoint();
    crate::process_window::hide_command_window(&mut cmd);
    let output = cmd
        .args(["debug", "models"])
        .output()
        .await
        .map_err(|e| format!("failed to query Codex models: {e}"))?;

    if output.status.success() {
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&output.stdout) {
            return Ok(parse_codex_models(&value));
        }
    }

    Ok(Vec::new())
}

fn parse_codex_models(value: &serde_json::Value) -> Vec<String> {
    let Some(models) = value.get("models").and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    models
        .iter()
        .filter_map(|model| {
            model
                .get("slug")
                .or_else(|| model.get("id"))
                .or_else(|| model.get("name"))
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|model| !model.is_empty())
        })
        .filter(|model| seen.insert((*model).to_string()))
        .map(str::to_string)
        .collect()
}

fn read_codex_config_model() -> Option<String> {
    let config_path = dirs::home_dir()?.join(".codex").join("config.toml");
    let content = std::fs::read_to_string(config_path).ok()?;
    parse_codex_config_model(&content)
}

/// 轻量解析 `~/.codex/config.toml` 顶层 `model = "..."`�?/// 不引入完�?TOML parser ── �?��这一�? 逐�?�?��即可�?
fn parse_codex_config_model(content: &str) -> Option<String> {
    content.lines().find_map(|line| {
        let line = line.trim();
        if line.starts_with('#') || !line.starts_with("model") {
            return None;
        }
        let (key, value) = line.split_once('=')?;
        if key.trim() != "model" {
            return None;
        }
        let value = value
            .split('#')
            .next()
            .unwrap_or_default()
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_image_cache_accepts_safe_raster_formats_only() {
        assert_eq!(agent_image_extension("image/png"), Some("png"));
        assert_eq!(agent_image_extension("IMAGE/JPEG"), Some("jpg"));
        assert_eq!(agent_image_extension("image/webp"), Some("webp"));
        assert_eq!(agent_image_extension("image/gif"), Some("gif"));
        assert_eq!(agent_image_extension("image/svg+xml"), None);
        assert_eq!(agent_image_extension("text/html"), None);
    }

    #[test]
    fn agent_image_cache_rejects_files_outside_its_root() {
        let root =
            std::env::temp_dir().join(format!("flowix-agent-image-root-{}", std::process::id()));
        let outside = std::env::temp_dir().join(format!(
            "flowix-agent-image-outside-{}.png",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).expect("create cache root");
        let inside = root.join("inside.png");
        std::fs::write(&inside, b"png").expect("create inside image");
        std::fs::write(&outside, b"png").expect("create outside image");
        assert!(ensure_path_within_image_cache(&root, &inside).is_ok());
        assert!(ensure_path_within_image_cache(&root, &outside).is_err());
        let _ = std::fs::remove_file(outside);
        let _ = std::fs::remove_dir_all(root);
    }

    fn message_with_agent_type(agent_type: Option<&str>) -> AgentUserMessage {
        AgentUserMessage {
            content: "hello".to_string(),
            llm_content: None,
            image_paths: vec![],
            run_id: None,
            system_reminder_directory: None,
            agent_type: agent_type.map(str::to_string),
            runtime_config: None,
            permission_mode: None,
            codex_model: None,
            codex_reasoning_effort: None,
            agent_role_memo_id: None,
            agent_role_name: None,
            conversation_title: None,
        }
    }

    #[test]
    fn agent_runtime_defaults_to_flowix() {
        assert_eq!(
            AgentRuntime::from_message(&message_with_agent_type(None)),
            AgentRuntime::Flowix
        );
        assert_eq!(
            AgentRuntime::from_message(&message_with_agent_type(Some(""))),
            AgentRuntime::Flowix
        );
    }

    #[test]
    fn agent_runtime_normalizes_known_agent_types() {
        let cases = [
            ("flowix", AgentRuntime::Flowix),
            (" CODEX ", AgentRuntime::Codex),
            ("Claude", AgentRuntime::Claude),
            ("gemini", AgentRuntime::Gemini),
            ("HERMES", AgentRuntime::Hermes),
            ("openclaw", AgentRuntime::OpenClaw),
        ];

        for (agent_type, expected) in cases {
            assert_eq!(
                AgentRuntime::from_message(&message_with_agent_type(Some(agent_type))),
                expected,
                "agent_type {agent_type:?} should map to {expected:?}"
            );
        }
    }

    #[test]
    fn agent_runtime_unknown_values_fall_back_to_flowix() {
        assert_eq!(
            AgentRuntime::from_message(&message_with_agent_type(Some("unknown-agent"))),
            AgentRuntime::Flowix
        );
    }

    #[test]
    fn parses_codex_config_model() {
        assert_eq!(
            parse_codex_config_model("model = \"gpt-5.5\"\n").as_deref(),
            Some("gpt-5.5")
        );
        assert_eq!(
            parse_codex_config_model("model = 'gpt-5-codex' # comment\n").as_deref(),
            Some("gpt-5-codex")
        );
        assert_eq!(parse_codex_config_model("service_tier = \"default\""), None);
    }

    #[test]
    fn parses_codex_supported_models() {
        let value = serde_json::json!({
            "models": [
                { "slug": "gpt-5.6" },
                { "id": "gpt-5.6-sol" },
                { "name": "gpt-5.6-terra" },
                { "slug": "gpt-5.6" },
                { "slug": "" }
            ]
        });

        assert_eq!(
            parse_codex_models(&value),
            vec!["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra"]
        );
    }
}
