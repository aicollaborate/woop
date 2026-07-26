//! Agent 访问�?�� IPC —读写 `~/.flowix/agent-access.json`�?//!
//! �?`commands::settings` 同形: 写操作成功后 emit `agent-access-changed`
//! 事件, 其它窗口�?React 树收到后从�?盘重�?load�?前�? `set_agent_access`
//! 走乐观更�?(改本地后�?await), 失败�?store �?`loadInitial` 回滚 ──
//! 瑙?`app/flowix-web/lib/store/agent-access-store.ts`銆?
use std::path::Path;

use crate::events as dispatcher;
use tauri::{AppHandle, State};

use crate::config::{AgentAccessConfig, AgentAccessEntry, AgentAccessKind};

use crate::app::state::AppState;

/// 跨窗口同步事�?── 任一窗口成功写入 agent-access.json �?emit, 其它窗口
/// 收到后从磁盘重新 load�?payload �?`()` (�?payload), 监听者直�?/// `loadInitial()` 拉整�?config ── 比按 entry diff 简单且不会错过任何字�?�?
pub(super) const AGENT_ACCESS_CHANGED_EVENT: &str = "agent-access-changed";

/// 拉取当前 agent_access 整份 config�?每�?都从 store �? `missing` 字�?
/// �?`get_config` 内重新算, 失联�?��会立刻拿到最�?disk 状态�?
#[tauri::command]
pub fn get_agent_access(state: State<AppState>) -> AgentAccessConfig {
    state.agent_access.get_config()
}

/// 用整份新 config 覆盖 (前�?走乐观更�? 整份 set 避免一�?IPC 一份的
/// 复杂协�?)�?先落�? �?emit, 成功才更新内�?(�?user_config �?set
/// �?��完全对齐)�?
#[tauri::command]
pub fn set_agent_access(
    config: AgentAccessConfig,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    state
        .agent_access
        .replace_config(config)
        .map(|_| {
            dispatcher::emit_to(&app, AGENT_ACCESS_CHANGED_EVENT, ());
            Ok(())
        })
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn add_agent_access_folder_from_picker(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<AgentAccessEntry>, String> {
    let picked = crate::commands::dialog::select_directory(app.clone()).await;
    let Some(path) = picked else {
        return Ok(None);
    };
    let trimmed = path.trim_end_matches(|c| c == '/' || c == '\\').to_string();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let mut config = state.agent_access.get_config();
    if let Some(existing) = reusable_tracked_folder(&config, &trimmed)? {
        // Folder entries form a global metadata/bookmark pool while
        // `defaults.files[notebook_id]` owns the per-notebook attachment.
        // Returning the existing folder lets a removed folder be attached
        // again and lets multiple notebooks reference the same directory.
        return Ok(Some(existing));
    }

    let now = chrono::Utc::now().timestamp_millis();
    let name = Path::new(&trimmed)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&trimmed)
        .to_string();
    let entry = AgentAccessEntry {
        id: format!("fld_{}", nanoid::nanoid!(6)),
        kind: AgentAccessKind::Folder,
        path: trimmed,
        name,
        enabled: true,
        workspace: false,
        added_at: now,
        updated_at: now,
        missing: false,
    };
    config.entries.push(entry.clone());
    state
        .agent_access
        .replace_config(config)
        .map_err(|e| format!("agent access persist failed: {e}"))?;
    dispatcher::emit_to(&app, AGENT_ACCESS_CHANGED_EVENT, ());
    Ok(Some(entry))
}

fn reusable_tracked_folder(
    config: &AgentAccessConfig,
    path: &str,
) -> Result<Option<AgentAccessEntry>, String> {
    let comparable = path
        .trim_end_matches(|c| c == '/' || c == '\\')
        .to_ascii_lowercase();
    let Some(existing) = config.entries.iter().find(|entry| {
        entry
            .path
            .trim_end_matches(|c| c == '/' || c == '\\')
            .to_ascii_lowercase()
            == comparable
    }) else {
        return Ok(None);
    };
    if existing.kind == AgentAccessKind::Folder {
        Ok(Some(existing.clone()))
    } else {
        Err("path already tracked as notebook".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(kind: AgentAccessKind, path: &str) -> AgentAccessEntry {
        AgentAccessEntry {
            id: "entry".to_string(),
            kind,
            path: path.to_string(),
            name: "Entry".to_string(),
            enabled: true,
            workspace: false,
            added_at: 1,
            updated_at: 1,
            missing: false,
        }
    }

    #[test]
    fn existing_folder_is_reusable_across_notebooks_and_after_removal() {
        let config = AgentAccessConfig {
            version: 1,
            entries: vec![entry(AgentAccessKind::Folder, "/tmp/reference")],
            defaults: None,
        };

        let reused = reusable_tracked_folder(&config, "/tmp/reference/")
            .unwrap()
            .expect("folder should be reused");

        assert_eq!(reused.path, "/tmp/reference");
    }

    #[test]
    fn notebook_path_is_not_reused_as_folder_metadata() {
        let config = AgentAccessConfig {
            version: 1,
            entries: vec![entry(AgentAccessKind::Notebook, "/tmp/notebook")],
            defaults: None,
        };

        assert!(reusable_tracked_folder(&config, "/tmp/notebook").is_err());
    }
}
