//! Tauri IPC: `open_memo_by_target` —接收任意形式�?打开�?��", 解析 +
//! 落盘校验 + emit `flowix:open-target` 给前�?�?前�?做真正的 UI 切换�?//!
//! 这是后�?"权威解析"边界 ── 前�?�?���?粘贴 / Agent / 跨窗�?拿不到完�?//! notebook 信息, 一律走这个 IPC 让后�?��磁盘�?//!
//! ## 澶辫触璇箟
//!
//! - `Err(String)` �?前�? await 抛错, 调用�?`try/catch` 静默 return�?//! - 解析失败 (`OpenTargetError`) / 解析后查不到 (`ResolveError`) 都映射到 `None`,
//!   前�?视为"用户粘贴了不存在的路�?�?memo 已�?�?, 静默 no-op�?
use crate::events as dispatcher;
use tauri::{AppHandle, State};

use super::parser::parse_open_target;
use super::resolver::resolve_open_target;
use super::ResolvedOpenTarget;

/// Tauri command: 接收任意 `OpenTarget` 原�?字�?�? 返回 `ResolvedOpenTarget`�?///
/// 鍓綔鐢?
/// - emit `flowix:open-target` 事件给所有窗�?(主窗口优先�?�?�?
#[tauri::command]
pub fn open_memo_by_target(
    raw: String,
    emit_event: Option<bool>,
    state: State<'_, crate::app::state::AppState>,
    app: AppHandle,
) -> Option<ResolvedOpenTarget> {
    let parsed = match parse_open_target(&raw) {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!("[open_target] parse failed: {e}");
            return None;
        }
    };

    let resolved = match resolve_open_target(parsed, state.memo_file.as_ref()) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("[open_target] resolve failed: {e}");
            return None;
        }
    };

    // 推前�? 主窗�?+ 偏好窗口都能收到, 由前�?listener �??判断�?��处理�?    // 主窗�?prefs 窗口都挂�?listener (顶层 app.tsx), 主窗口负责真正打开,
    // 偏好窗口收到后直接忽略�?    // emit_to 返回 bool 用于诊断, 错�?�?agent.rs::emit_chunk 一致留追踪�?
    if emit_event.unwrap_or(true) && !dispatcher::emit_to(&app, "flowix:open-target", &resolved) {
        tracing::warn!("[open_target] emit failed (no subscribers or transport error)");
    }

    Some(resolved)
}
