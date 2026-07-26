//! 偏好 / AI 配置 IPC —`~/.flowix/boot/preference.json` + `~/.flowix/agent-config.toml`�?//!
//! 两个 JSON 文件�?`crate::config::UserConfigStore` 管理 (原子�? 0o600)�?//! 写入成功�?emit `user-config-changed` 事件, 让�?窗口 React 树重�?load�?
use crate::events as dispatcher;
use tauri::{AppHandle, State};

use crate::agent_flowix::provider::{probe_chat, TestConnectionResult};
use crate::config::{AiConfigFile, AiModelConfig, PreferenceFile};

use crate::app::state::AppState;

/// 跨窗口同步事�?—任一窗口成功写入偏好 / AI 配置�?emit, 其它窗口
/// (主窗�?/ 偏好窗口 / �?��的�?窗口) 收到后从磁盘重新 load�?/// 解决: 两个 Tauri 窗口各跑�?�� React �?+ �?�� zustand store, 一�?/// 改动另一边看不到的问题�?
pub(super) const USER_CONFIG_CHANGED_EVENT: &str = "user-config-changed";

/// 用户偏好 (preference.json) —�?~/.flowix/boot/preference.json
#[tauri::command]
pub fn get_preference(state: State<AppState>) -> PreferenceFile {
    state.user_config.get_preference()
}

#[tauri::command]
pub fn set_preference(
    preference: PreferenceFile,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    state
        .user_config
        .set_preference(preference)
        .map(|_| {
            dispatcher::emit_to(&app, USER_CONFIG_CHANGED_EVENT, "preference");
            Ok(())
        })
        .map_err(|e| e.to_string())?
}

/// AI 模型配置 (agent-config.toml) —�?~/.flowix/agent-config.toml
#[tauri::command]
pub fn get_ai_config(state: State<AppState>) -> AiConfigFile {
    state.user_config.get_ai_config()
}

#[tauri::command]
pub fn set_ai_config(
    config: AiConfigFile,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    state
        .user_config
        .set_ai_config(config)
        .map(|_| {
            dispatcher::emit_to(&app, USER_CONFIG_CHANGED_EVENT, "ai_config");
            Ok(())
        })
        .map_err(|e| e.to_string())?
}

/// 文件监听�?黑名�?(PR2) —�?`preference.json::watcher` 字�?�?///
/// 鎻愪緵鐙珛 IPC, 閬垮厤鍓嶇涓烘敼涓€涓瓧娈典紶瀹屾暣 PreferenceFile; 鍐欏悗
/// emit `user-config-changed` 瑙﹀彂 `MemoWatcher::set_whitelist` 鐑洿鏂般€?
#[tauri::command]
pub fn get_watcher_config(state: State<AppState>) -> crate::watcher::WhitelistConfig {
    state.user_config.get_preference().watcher
}

#[tauri::command]
pub fn update_watcher_config(
    config: crate::watcher::WhitelistConfig,
    state: State<AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let mut pref = state.user_config.get_preference();
    pref.watcher = config;
    state
        .user_config
        .set_preference(pref)
        .map(|_| {
            dispatcher::emit_to(&app, USER_CONFIG_CHANGED_EVENT, "watcher");
            Ok(())
        })
        .map_err(|e| e.to_string())?
}

/// One-shot connectivity probe for the AI configuration form.
///
/// Distinct from `set_ai_config`:
/// - **Does not write to disk** 鈥?the user is editing, not committing.
/// - **Does not emit** `user-config-changed` 鈥?no cross-window reload needed.
/// - **Bypasses** the `AgentManager` provider cache 鈥?each probe uses a
///   fresh instance built from the exact config being tested.
///
/// Returns a structured `TestConnectionResult` (always 200-shaped for the
/// IPC boundary; failures live in `result.error.kind`), so the UI can pick
/// the right hint based on auth vs network vs bad-model etc.
///
/// Note: `AiModelConfig` is `#[serde(rename_all = "camelCase")]`, so the
/// front-end sends `apiUrl` / `apiKeys` directly 鈥?no extra conversion.
#[tauri::command]
pub async fn test_ai_connection(config: AiModelConfig) -> TestConnectionResult {
    probe_chat(&config).await
}
