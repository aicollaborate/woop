//! Thread IPC —对话线程 CRUD�?//!
//! `thread_delete` 顺带�?`AgentManager` �?in-memory 状�?(与�? thread 关联�?//! read 工具�?�� + 卡�?检测�?�?, 否则会无限泄露�?
use serde::Serialize;
use tauri::State;

use crate::agent_flowix::default_agent_id;
use crate::agent_session::{
    AgentConversationInstance, ChatMessage, ThreadInfo, ThreadMessagesPage,
    UpsertAgentConversationInstance,
};

use crate::app::state::AppState;

#[derive(Serialize)]
pub struct GetThreadResponse {
    pub messages: Vec<ChatMessage>,
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
    let manager = &state.thread_manager;
    manager
        .list_codex_event_threads()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn codex_thread_get(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<GetThreadResponse, String> {
    let manager = &state.thread_manager;
    if let Some(mut page) = manager
        .get_codex_event_messages_page(&thread_id, None, 50)
        .await
        .map_err(|e| e.to_string())?
    {
        let mut messages = page.messages;
        while page.has_more {
            page = manager
                .get_codex_event_messages_page(&thread_id, page.oldest_sequence, 50)
                .await
                .map_err(|e| e.to_string())?
                .unwrap_or(ThreadMessagesPage {
                    messages: Vec::new(),
                    oldest_sequence: None,
                    has_more: false,
                });
            let mut combined = page.messages;
            combined.extend(messages);
            messages = combined;
        }
        return Ok(GetThreadResponse { messages });
    }

    let session_id = if crate::agent_external::codex::is_codex_session_id(&thread_id) {
        thread_id
    } else {
        manager
            .get_external_session(&thread_id, "codex")
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or(thread_id)
    };
    let messages = crate::agent_external::codex::get_session(&session_id).await?;
    Ok(GetThreadResponse { messages })
}

#[tauri::command]
pub async fn codex_thread_get_page(
    thread_id: String,
    before_sequence: Option<i64>,
    limit: i64,
    state: State<'_, AppState>,
) -> Result<ThreadMessagesPage, String> {
    let manager = &state.thread_manager;
    if let Some(page) = manager
        .get_codex_event_messages_page(&thread_id, before_sequence, limit)
        .await
        .map_err(|e| e.to_string())?
    {
        return Ok(page);
    }

    let session_id = if crate::agent_external::codex::is_codex_session_id(&thread_id) {
        thread_id
    } else {
        manager
            .get_external_session(&thread_id, "codex")
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or(thread_id)
    };
    crate::agent_external::codex::get_session_page(&session_id, before_sequence, limit).await
}

#[tauri::command]
pub async fn codex_thread_session_id(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    if crate::agent_external::codex::is_codex_session_id(&thread_id) {
        return Ok(Some(thread_id));
    }

    let manager = &state.thread_manager;
    manager
        .get_external_session(&thread_id, "codex")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn claude_thread_list(state: State<'_, AppState>) -> Result<Vec<ThreadInfo>, String> {
    let manager = &state.thread_manager;
    manager
        .list_external_threads("claude")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn claude_thread_get(thread_id: String) -> Result<GetThreadResponse, String> {
    let messages = crate::agent_external::claude::get_session(&thread_id).await?;
    Ok(GetThreadResponse { messages })
}

#[tauri::command]
pub async fn claude_thread_get_page(
    thread_id: String,
    before_sequence: Option<i64>,
    limit: i64,
    state: State<'_, AppState>,
) -> Result<ThreadMessagesPage, String> {
    if let Some(page) = state
        .thread_manager
        .get_claude_event_messages_page(&thread_id, before_sequence, limit)
        .await
        .map_err(|error| error.to_string())?
    {
        return Ok(page);
    }
    // Rollout is retained strictly as a fallback for sessions whose database
    // event source is empty.
    crate::agent_external::claude::get_session_page(&thread_id, before_sequence, limit).await
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
    let manager = &state.thread_manager;
    manager
        .list_external_threads("hermes")
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn hermes_thread_get(
    thread_id: String,
    state: State<'_, AppState>,
) -> Result<GetThreadResponse, String> {
    if let Some(mut page) = state
        .thread_manager
        .get_external_event_messages_page("hermes", &thread_id, None, 50)
        .await
        .map_err(|error| error.to_string())?
    {
        let mut messages = page.messages;
        while page.has_more {
            page = state
                .thread_manager
                .get_external_event_messages_page(
                    "hermes",
                    &thread_id,
                    page.oldest_sequence,
                    50,
                )
                .await
                .map_err(|error| error.to_string())?
                .unwrap_or(ThreadMessagesPage {
                    messages: Vec::new(),
                    oldest_sequence: None,
                    has_more: false,
                });
            let mut combined = page.messages;
            combined.extend(messages);
            messages = combined;
        }
        return Ok(GetThreadResponse { messages });
    }
    let messages = crate::agent_external::hermes::get_session(&thread_id).await?;
    Ok(GetThreadResponse { messages })
}

#[tauri::command]
pub async fn hermes_thread_get_page(
    thread_id: String,
    before_sequence: Option<i64>,
    limit: i64,
    state: State<'_, AppState>,
) -> Result<ThreadMessagesPage, String> {
    if let Some(page) = state
        .thread_manager
        .get_external_event_messages_page("hermes", &thread_id, before_sequence, limit)
        .await
        .map_err(|error| error.to_string())?
    {
        return Ok(page);
    }
    crate::agent_external::hermes::get_session_page(&thread_id, before_sequence, limit).await
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
        .thread_manager
        .list_opencode_event_threads()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn opencode_thread_get_page(
    thread_id: String,
    before_sequence: Option<i64>,
    limit: i64,
    state: State<'_, AppState>,
) -> Result<ThreadMessagesPage, String> {
    if let Some(page) = state
        .thread_manager
        .get_opencode_event_messages_page(&thread_id, before_sequence, limit)
        .await
        .map_err(|error| error.to_string())?
    {
        return Ok(page);
    }
    let session_id = state
        .thread_manager
        .get_external_session(&thread_id, "opencode")
        .await
        .map_err(|error| error.to_string())?
        .unwrap_or(thread_id);
    crate::agent_external::opencode::get_session_page(&session_id, before_sequence, limit).await
}

#[tauri::command]
pub async fn thread_delete(
    thread_id: String,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<bool, String> {
    let flowix_stopped = state.agent_manager.stop_chat(&thread_id, None).await;
    let external_stopped = state
        .external_runtimes
        .stop_chat_all(&thread_id, &app_handle)
        .await;
    if flowix_stopped || external_stopped {
        tracing::info!("[Thread] stopped running agent before deleting thread {thread_id}");
    }

    // 先清 AgentManager �?in-memory 状�?── 与�? thread 关联�?read 工具�?��
    // (HashMap<thread_id, HashMap<path, full_file_content>>, 整本笔�?�?���?
    // 与卡死�?测�?�? 否则会无限泄露。两张表�?�� HashMap.remove, 总是成功�?    //
    // `agent_manager` �?`Arc<AgentManager>`, `cleanup_thread` �?`&self` 方法,
    // `agent_manager` is an `Arc<AgentManager>` and cleanup takes `&self`.
    state.agent_manager.cleanup_thread(&thread_id).await;
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
