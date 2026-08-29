//! Thread IPC ── 对话线程 CRUD。
use serde::Serialize;
use tauri::State;

use crate::agent_history::ExternalRuntimeKind;
use crate::agent_session::{
    AgentConversationInstance, ChatMessage, ThreadInfo, ThreadMessagesPage,
    UpsertAgentConversationInstance,
};
use crate::agent_types::default_agent_id;

use crate::app::state::AppState;

#[derive(Serialize)]
pub struct GetThreadResponse {
    pub messages: Vec<ChatMessage>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConversationPage {
    pub items: Vec<AgentConversationInstance>,
    pub has_more: bool,
}

#[tauri::command]
pub async fn thread_list(state: State<'_, AppState>) -> Result<Vec<ThreadInfo>, String> {
    let manager = &state.thread_manager;
    manager.list_threads().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn local_agent_thread_list(
    agent_type: String,
    state: State<'_, AppState>,
) -> Result<Vec<ThreadInfo>, String> {
    let agent_type = agent_type.trim().to_ascii_lowercase();
    if !matches!(agent_type.as_str(), "hermes") {
        return Err(format!("unsupported local agent type: {agent_type}"));
    }

    let manager = &state.thread_manager;
    manager
        .list_threads_by_agent(&agent_type)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn thread_create(
    title: String,
    state: State<'_, AppState>,
) -> Result<ThreadInfo, String> {
    let manager = &state.thread_manager;
    // 所�?thread 都用 default_agent_id() 占位 ── �?agent.rs�?
    manager
        .create_thread(default_agent_id(), title)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn thread_get(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<GetThreadResponse, String> {
    let manager = &state.thread_manager;
    match manager
        .get_thread(&thread_id)
        .await
        .map_err(|e| e.to_string())?
    {
        Some(thread) => Ok(GetThreadResponse {
            messages: thread.messages,
        }),
        None => Err("Thread not found".to_string()),
    }
}

/// Layer 4: 分页加载 thread 历史. 取代 thread_get �?1MB �?thread 上的全量
/// 序列化开销, IPC payload �?~1MB 降到 ~100KB (100 �?× 平均 1KB).
///
/// 鍙傛暟:
///   - thread_id: 鐩爣 thread
///   - before_sequence: None �?取最�?limit �? Some(s) �?�?sequence < s 的最�?limit �?///   - limit: 单�?返回上限, 服务�?clamp �?[1, 1000], 默�?建�?前�?�?100
///
/// 杩斿洖 ThreadMessagesPage { messages (ASC), oldest_sequence, has_more }
/// 前�?�?oldest_sequence 作为下一�?cursor, has_more 决定顶部 prefetch.
///
/// thread_get 淇濈暀 鈹€鈹€ 璋冭瘯 / 鍏ㄩ噺瀵煎嚭璺緞浠嶅彲鑳界敤鍒般€?
#[tauri::command]
pub async fn thread_get_page(
    thread_id: String,
    before_sequence: Option<i64>,
    limit: i64,
    state: State<'_, AppState>,
) -> Result<ThreadMessagesPage, String> {
    let manager = &state.thread_manager;
    manager
        .get_thread_messages_page(&thread_id, before_sequence, limit)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_conversation_list(
    state: State<'_, AppState>,
) -> Result<Vec<AgentConversationInstance>, String> {
    let manager = &state.thread_manager;
    manager
        .list_agent_conversation_instances()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_conversation_list_page(
    offset: usize,
    limit: usize,
    state: State<'_, AppState>,
) -> Result<AgentConversationPage, String> {
    let page_size = limit.clamp(1, 100);
    let manager = &state.thread_manager;
    let items = manager
        .list_agent_conversation_instances_page(offset, page_size + 1)
        .await
        .map_err(|e| e.to_string())?;
    let has_more = items.len() > page_size;
    Ok(AgentConversationPage {
        items: items.into_iter().take(page_size).collect(),
        has_more,
    })
}

#[tauri::command]
pub async fn agent_conversation_count_by_notebook(
    notebook_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let manager = &state.thread_manager;
    manager
        .count_agent_conversation_instances_by_notebook(notebook_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_conversation_get(
    instance_id: String,
    state: State<'_, AppState>,
) -> Result<Option<AgentConversationInstance>, String> {
    let manager = &state.thread_manager;
    manager
        .get_agent_conversation_instance(&instance_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_conversation_find_by_thread(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Option<AgentConversationInstance>, String> {
    let manager = &state.thread_manager;
    manager
        .find_agent_conversation_by_thread_id(&thread_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_conversation_upsert(
    instance: UpsertAgentConversationInstance,
    state: State<'_, AppState>,
) -> Result<AgentConversationInstance, String> {
    let manager = &state.thread_manager;
    manager
        .upsert_agent_conversation_instance(instance)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_conversation_delete(
    instance_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let manager = &state.thread_manager;
    manager
        .delete_agent_conversation_instance(&instance_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_conversation_delete_for_thread(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    let manager = &state.thread_manager;
    manager
        .delete_agent_conversation_instances_for_thread(&thread_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn codex_thread_list(state: State<'_, AppState>) -> Result<Vec<ThreadInfo>, String> {
    state
        .agent_history
        .list_threads(ExternalRuntimeKind::Codex)
        .await
}

#[tauri::command]
pub async fn codex_thread_get(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<GetThreadResponse, String> {
    let messages = state
        .agent_history
        .read_all(ExternalRuntimeKind::Codex, &thread_id)
        .await?;
    Ok(GetThreadResponse { messages })
}

#[tauri::command]
pub async fn codex_thread_get_page(
    thread_id: String,
    before_sequence: Option<i64>,
    limit: i64,
    state: State<'_, AppState>,
) -> Result<ThreadMessagesPage, String> {
    state
        .agent_history
        .read_page(
            ExternalRuntimeKind::Codex,
            &thread_id,
            before_sequence,
            limit,
        )
        .await
}

#[tauri::command]
pub async fn codex_thread_session_id(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let manager = &state.thread_manager;
    let session = manager
        .get_external_session(&thread_id, "codex")
        .await
        .map_err(|e| e.to_string())?;
    Ok(session.or(Some(thread_id)))
}

#[tauri::command]
pub async fn claude_thread_list(state: State<'_, AppState>) -> Result<Vec<ThreadInfo>, String> {
    state
        .agent_history
        .list_threads(ExternalRuntimeKind::Claude)
        .await
}

#[tauri::command]
pub async fn claude_thread_get(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<GetThreadResponse, String> {
    let messages = state
        .agent_history
        .read_all(ExternalRuntimeKind::Claude, &thread_id)
        .await?;
    Ok(GetThreadResponse { messages })
}

#[tauri::command]
pub async fn claude_thread_get_page(
    thread_id: String,
    before_sequence: Option<i64>,
    limit: i64,
    state: State<'_, AppState>,
) -> Result<ThreadMessagesPage, String> {
    state
        .agent_history
        .read_page(
            ExternalRuntimeKind::Claude,
            &thread_id,
            before_sequence,
            limit,
        )
        .await
}

#[tauri::command]
pub async fn claude_thread_session_id(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    if crate::agent_external::claude::is_claude_session_id(&thread_id) {
        return Ok(Some(thread_id));
    }

    let manager = &state.thread_manager;
    manager
        .get_external_session(&thread_id, "claude")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn hermes_thread_list(state: State<'_, AppState>) -> Result<Vec<ThreadInfo>, String> {
    state
        .agent_history
        .list_threads(ExternalRuntimeKind::Hermes)
        .await
}

#[tauri::command]
pub async fn hermes_thread_get(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<GetThreadResponse, String> {
    let messages = state
        .agent_history
        .read_all(ExternalRuntimeKind::Hermes, &thread_id)
        .await?;
    Ok(GetThreadResponse { messages })
}

#[tauri::command]
pub async fn hermes_thread_get_page(
    thread_id: String,
    before_sequence: Option<i64>,
    limit: i64,
    state: State<'_, AppState>,
) -> Result<ThreadMessagesPage, String> {
    state
        .agent_history
        .read_page(
            ExternalRuntimeKind::Hermes,
            &thread_id,
            before_sequence,
            limit,
        )
        .await
}

#[tauri::command]
pub async fn hermes_thread_session_id(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    if crate::agent_external::hermes::is_hermes_session_id(&thread_id) {
        return Ok(Some(thread_id));
    }

    let manager = &state.thread_manager;
    manager
        .get_external_session(&thread_id, "hermes")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn deepseek_harness_thread_list(
    state: State<'_, AppState>,
) -> Result<Vec<ThreadInfo>, String> {
    state
        .agent_history
        .list_threads(ExternalRuntimeKind::DeepSeekHarness)
        .await
}

#[tauri::command]
pub async fn deepseek_harness_thread_get(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<GetThreadResponse, String> {
    let messages = state
        .agent_history
        .read_all(ExternalRuntimeKind::DeepSeekHarness, &thread_id)
        .await?;
    Ok(GetThreadResponse { messages })
}

#[tauri::command]
pub async fn deepseek_harness_thread_get_page(
    thread_id: String,
    before_sequence: Option<i64>,
    limit: i64,
    state: State<'_, AppState>,
) -> Result<ThreadMessagesPage, String> {
    state
        .agent_history
        .read_page(
            ExternalRuntimeKind::DeepSeekHarness,
            &thread_id,
            before_sequence,
            limit,
        )
        .await
}

#[tauri::command]
pub async fn deepseek_harness_thread_session_id(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    state
        .thread_manager
        .get_external_session(&thread_id, "deepseek-harness")
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn deepseek_harness_session_usage(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Option<crate::agent_external::deepseek_harness::DeepSeekHarnessSessionUsage>, String> {
    state.deepseek_harness.session_usage(&thread_id).await
}

#[tauri::command]
pub async fn opencode_thread_session_id(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    // OpenCode ACP 的 session id 由 `OpenCodeAcpManager.controls` 持有 ── 与
    // codex / claude / hermes 不同, 没有"扫描 vendor 文件"这一步。
    // 这里只走 ThreadManager 的映射, 没有命中就走通用 fallback。
    let manager = &state.thread_manager;
    manager
        .get_external_session(&thread_id, "opencode")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn opencode_thread_list(state: State<'_, AppState>) -> Result<Vec<ThreadInfo>, String> {
    state
        .agent_history
        .list_threads(ExternalRuntimeKind::OpenCode)
        .await
}

#[tauri::command]
pub async fn opencode_thread_get_page(
    thread_id: String,
    before_sequence: Option<i64>,
    limit: i64,
    state: State<'_, AppState>,
) -> Result<ThreadMessagesPage, String> {
    state
        .agent_history
        .read_page(
            ExternalRuntimeKind::OpenCode,
            &thread_id,
            before_sequence,
            limit,
        )
        .await
}

#[tauri::command]
pub async fn thread_delete(
    thread_id: String,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<bool, String> {
    let stopped = state
        .external_runtimes
        .stop_chat_all(&thread_id, &app_handle)
        .await;
    if stopped {
        tracing::info!("[Thread] stopped running agent before deleting thread {thread_id}");
    }

    let manager = &state.thread_manager;
    manager
        .delete_thread_with_agent_conversations(&thread_id)
        .await
        .map_err(|e| e.to_string())
}

/// 重命�?thread ── �?SQLite `threads.title` �? 顺带 bump `updated_at`,
/// 让历史列表按"最近活�?排序�? 刚�?改名的�?话能正�顶到顶部�?///
/// 返回 `None` 表示 thread 不存�?(UI 应忽�?; 返回 `Some(info)` �?info.title
/// 已经�?���? �?��接用于更新本�?store。前�?`sendMessageStream` 在�?条用�?/// 消息落地后调一�? 覆盖"点了"新建对话"再发消息"的早期路�?那�?情况�?/// `ensureThread` �?early return, 不会生成新标�?�?
#[tauri::command]
#[allow(non_snake_case)]
pub async fn thread_update_title(
    thread_id: String,
    title: String,
    agentType: Option<String>,
    state: State<'_, AppState>,
) -> Result<Option<ThreadInfo>, String> {
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return Err("Thread title cannot be empty".to_string());
    }
    tracing::info!(
        "[Thread] update title requested for thread_id: {}, agent_type: {}",
        thread_id,
        agentType.as_deref().unwrap_or("unknown")
    );
    let agent_id = agentType
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("default");
    let manager = &state.thread_manager;
    manager
        .update_title(
            &thread_id,
            title,
            crate::agent_types::AgentId::new(agent_id),
        )
        .await
        .map_err(|e| e.to_string())
}
