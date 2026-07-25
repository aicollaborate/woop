//! Agent 璁块棶鐩綍 IPC 鈥?璇诲啓 `~/.flowix/agent-access.json`銆?//!
//! 涓?`commands::settings` 鍚屽舰: 鍐欐搷浣滄垚鍔熷悗 emit `agent-access-changed`
//! 浜嬩欢, 鍏跺畠绐楀彛鐨?React 鏍戞敹鍒板悗浠庣鐩橀噸鏂?load銆?鍓嶇 `set_agent_access`
//! 璧颁箰瑙傛洿鏂?(鏀规湰鍦板悗鍐?await), 澶辫触鐢?store 鐨?`loadInitial` 鍥炴粴 鈹€鈹€
//! 瑙?`app/flowix-web/lib/store/agent-access-store.ts`銆?
use std::path::Path;

use crate::events as dispatcher;
use tauri::{AppHandle, State};

use crate::config::{AgentAccessConfig, AgentAccessEntry, AgentAccessKind};

use crate::app::state::AppState;

/// 璺ㄧ獥鍙ｅ悓姝ヤ簨浠?鈹€鈹€ 浠讳竴绐楀彛鎴愬姛鍐欏叆 agent-access.json 鍚?emit, 鍏跺畠绐楀彛
/// 鏀跺埌鍚庝粠纾佺洏閲嶆柊 load銆?payload 鏄?`()` (鏃?payload), 鐩戝惉鑰呯洿鎺?/// `loadInitial()` 鎷夋暣浠?config 鈹€鈹€ 姣旀寜 entry diff 绠€鍗曚笖涓嶄細閿欒繃浠讳綍瀛楁銆?
pub(super) const AGENT_ACCESS_CHANGED_EVENT: &str = "agent-access-changed";

/// 鎷夊彇褰撳墠 agent_access 鏁翠唤 config銆?姣忔閮戒粠 store 璇? `missing` 瀛楁
/// 鍦?`get_config` 鍐呴噸鏂扮畻, 澶辫仈鐩綍浼氱珛鍒绘嬁鍒版渶鏂?disk 鐘舵€併€?
#[tauri::command]
pub fn get_agent_access(state: State<AppState>) -> AgentAccessConfig {
    state.agent_access.get_config()
}

/// 鐢ㄦ暣浠芥柊 config 瑕嗙洊 (鍓嶇璧颁箰瑙傛洿鏂? 鏁翠唤 set 閬垮厤涓€鏉?IPC 涓€浠界殑
/// 澶嶆潅鍗忚)銆?鍏堣惤鐩? 鍐?emit, 鎴愬姛鎵嶆洿鏂板唴瀛?(璺?user_config 鐨?set
/// 璺緞瀹屽叏瀵归綈)銆?
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
