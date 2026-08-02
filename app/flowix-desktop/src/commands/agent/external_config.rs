use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use serde::Serialize;
use tauri::State;

use crate::agent_external_config::{AgentExternalEntry, AgentExternalSource};
use crate::app::state::AppState;

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
    hermes: AgentRuntimeAvailability,
    opencode: AgentRuntimeAvailability,
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
    let hermes = external_availability(cfg.get_entry("hermes"), "Hermes Agent CLI");
    let opencode = external_availability(cfg.get_entry("opencode"), "OpenCode CLI");

    AgentRuntimeStatus {
        flowix: AgentRuntimeAvailability {
            available: flowix_available,
            reason: (!flowix_available).then(|| "Flowix model is not configured".to_string()),
        },
        codex,
        claude,
        hermes,
        opencode,
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
