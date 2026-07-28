use std::{collections::HashMap, path::Path};

use tauri::State;

use crate::agent_external::runtime_registry::ExternalCliRuntime;
use crate::agent_flowix::{AgentChatResponse, AgentUserMessage, RunInfo};
use crate::agent_session::AgentExternalEvent;
use crate::app::state::AppState;

use super::image_cache::{
    resolve_cached_agent_image, MAX_AGENT_IMAGE_BYTES, MAX_AGENT_IMAGE_COUNT,
};
use super::runtime::{runtime_handle, stop_any_runtime_chat, AgentRuntime, ChatRuntime};

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
