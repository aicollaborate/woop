use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::Value;
use tokio::io::BufReader;

use super::events::{
    codex_chunk_metadata, codex_event_to_chunks, is_transient_codex_reconnect_event,
    parse_event_timestamp_millis,
};
use super::history::{
    get_rollout_tool_response_items_since, is_codex_session_id, CodexRolloutEvent,
};
use crate::agent_external::read_capped_line;
use super::runtime::{persist_and_emit_codex_chunk, persist_codex_chunk_with_metadata};
use super::tool_events::nested_exec_tool_names;
use super::{AGENT_TYPE, MAX_STDOUT_LINE_BYTES, MAX_TOOL_OUTPUT_CHARS};
use crate::agent_external::{
    emit_chunk_with_run_id_and_metadata, truncate_for_log, AgentChunkMetadata, ExternalRunRegistry,
};
use crate::agent_flowix::AgentChunk;
use crate::agent_session::ThreadManager;
use crate::runtime_log;
use crate::agent_external::shared::TurnEvents;

type CodexTurnEvents = TurnEvents;

/// Codex text merge: each delta replaces the whole row (no append).
fn observe_codex_turn(te: &mut TurnEvents, chunk: &AgentChunk, metadata: &AgentChunkMetadata) {
    match chunk {
        AgentChunk::Text { text, .. } | AgentChunk::Reasoning { text, .. } => {
            if text.is_empty() {
                return;
            }
            let role = if matches!(chunk, AgentChunk::Reasoning { .. }) {
                "reasoning"
            } else {
                "assistant"
            };
            let message_id = metadata
                .message_id
                .clone()
                .unwrap_or_else(|| format!("{role}-{}", te.events.len() + 1));
            let key = format!("{role}:{message_id}");
            let mut stored_metadata = metadata.clone();
            stored_metadata.message_id = Some(message_id);
            stored_metadata.content_mode = Some("snapshot");
            stored_metadata.message_phase = Some("completed");
            if let Some(index) = te.message_indexes.get(&key).copied() {
                te.events[index] = (chunk.clone(), stored_metadata);
            } else {
                te.message_indexes.insert(key, te.events.len());
                te.events.push((chunk.clone(), stored_metadata));
            }
        }
        AgentChunk::ToolCall { .. } => te.observe_tool_call(chunk, metadata),
        AgentChunk::ToolResult { .. } => te.observe_tool_result(chunk, metadata),
        AgentChunk::Usage { .. } => te.observe_usage(chunk, metadata),
        AgentChunk::Error { .. } => te.observe_error(chunk, metadata),
        _ => {}
    }
}


async fn persist_turn_events(
    thread_manager: &Arc<ThreadManager>,
    turn_events: &mut CodexTurnEvents,
    run_id: &str,
) {
    for (chunk, metadata) in std::mem::take(turn_events).events {
        persist_codex_chunk_with_metadata(thread_manager, &chunk, run_id, None, &metadata).await;
    }
}

pub(crate) async fn read_codex_stdout<R>(
    thread_id: String,
    run_id: String,
    app_handle: tauri::AppHandle,
    thread_manager: Arc<ThreadManager>,
    runs: ExternalRunRegistry,
    reader: BufReader<R>,
    stream_end_emitted: Arc<AtomicBool>,
    started_at_millis: i64,
) -> Result<(), String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut reader = reader;
    let mut seen_sessions = HashSet::new();
    let mut resolved_session_id = is_codex_session_id(&thread_id).then(|| thread_id.clone());
    let mut emit_thread_id = thread_id.clone();
    let mut terminal_signal = CodexRunSignal::Continue;
    let mut emitted_tool_ids = HashSet::new();
    let mut emitted_tool_signatures = HashMap::new();
    let mut blocked_post_completion_chunks = 0usize;
    let mut source_sequence = 0u64;
    let mut turn_events = CodexTurnEvents::default();
    loop {
        let line_result = read_capped_line(&mut reader, MAX_STDOUT_LINE_BYTES).await;
        let Some((line, line_truncated_by_reader)) = (match line_result {
            Ok(line) => line,
            Err(err) => {
                persist_turn_events(&thread_manager, &mut turn_events, &run_id).await;
                return Err(err);
            }
        }) else {
            break;
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        source_sequence = source_sequence.saturating_add(1);
        // dev-only: 鎶婂瓙杩涚▼ stdout 鍘熷琛岄暅鍍忓埌 ~/.flowix/debug/, 1:1 杩樺師
        // Mirror raw vendor output in debug builds; release builds are a no-op.
        runtime_log::dump_debug_stdout_line(AGENT_TYPE, &thread_id, &run_id, line);
        runs.touch(&thread_id, Some(&run_id)).await;
        if line_truncated_by_reader {
            runtime_log::record_agent_event(
                "warn",
                "codex_stdout",
                "codex.stdout_line_truncated",
                "Codex stdout line exceeded reader limit and was truncated",
                Some(&thread_id),
                Some(AGENT_TYPE),
                Some(serde_json::json!({
                    "line_bytes_limit": MAX_STDOUT_LINE_BYTES,
                    "line_preview": truncate_for_log(line),
                })),
            );
        }

        let Ok(value) = serde_json::from_str::<Value>(line) else {
            let line_chars = line.chars().count();
            let looks_like_event = looks_like_codex_json_event_line(line);
            runtime_log::record_agent_event(
                "warn",
                "codex_stdout",
                "codex.stdout_non_json",
                "Codex stdout emitted a non-JSON line",
                Some(&thread_id),
                Some(AGENT_TYPE),
                Some(serde_json::json!({
                    "line_chars": line_chars,
                    "line_truncated": line_chars > MAX_TOOL_OUTPUT_CHARS || line_truncated_by_reader,
                    "line_truncated_by_reader": line_truncated_by_reader,
                    "looks_like_event": looks_like_event,
                    "line_preview": truncate_for_log(line),
                })),
            );
            if looks_like_event {
                continue;
            }
            let text = if line_chars > MAX_TOOL_OUTPUT_CHARS {
                let truncated: String = line.chars().take(MAX_TOOL_OUTPUT_CHARS).collect();
                format!("{truncated}\n...[truncated]")
            } else {
                format!("{line}\n")
            };
            let chunk = AgentChunk::Text {
                thread_id: emit_thread_id.clone(),
                text,
            };
            let metadata = crate::agent_external::shared::complete_chunk_metadata(false, 
                AgentChunkMetadata {
                    message_phase: Some("completed"),
                    content_mode: Some("snapshot"),
                    ..Default::default()
                },
                &chunk,
                &run_id,
                chrono::Utc::now().timestamp_millis(),
                source_sequence,
                0,
            );
            observe_codex_turn(&mut turn_events, &chunk, &metadata);
            emit_chunk_with_run_id_and_metadata(
                &app_handle,
                &chunk,
                AGENT_TYPE,
                &run_id,
                &metadata,
            );
            continue;
        };

        log_codex_stdout_event(&thread_id, line, &value);

        if let Some(session_id) = extract_session_id(&value) {
            resolved_session_id = Some(session_id.clone());
            if seen_sessions.insert(session_id.clone()) {
                runtime_log::record_agent_event(
                    "info",
                    "codex_stdout",
                    "codex.session_resolved",
                    "Codex reported a session id",
                    Some(&thread_id),
                    Some(AGENT_TYPE),
                    Some(serde_json::json!({ "session_id": session_id })),
                );
                if let Err(err) = thread_manager
                    .upsert_external_session(
                        &thread_id,
                        AGENT_TYPE,
                        &session_id,
                        Some(value.clone()),
                    )
                    .await
                {
                    runtime_log::record_agent_event(
                        "warn",
                        "codex_stdout",
                        "codex.session_persist_failed",
                        "Failed to persist Codex external session mapping",
                        Some(&thread_id),
                        Some(AGENT_TYPE),
                        Some(serde_json::json!({
                            "session_id": session_id,
                            "error": err.to_string(),
                        })),
                    );
                    tracing::warn!(
                        "[CodexCli] failed to persist external session mapping for {thread_id}: {err}"
                    );
                }
                emit_thread_id = thread_id.clone();
                let chunk = AgentChunk::SessionResolved {
                    thread_id: thread_id.clone(),
                    session_id: session_id.clone(),
                };
                persist_and_emit_codex_chunk(
                    &app_handle,
                    &thread_manager,
                    &chunk,
                    &run_id,
                    Some(line),
                )
                .await;
                runs.set_session_id(&thread_id, Some(&run_id), session_id.clone())
                    .await;
            }
        }

        let source_timestamp = parse_event_timestamp_millis(&value)
            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
        for (source_subsequence, chunk) in codex_event_to_chunks(&emit_thread_id, &value)
            .into_iter()
            .enumerate()
        {
            if !should_emit_following_stdout_chunks(terminal_signal) {
                blocked_post_completion_chunks += 1;
                continue;
            }
            record_stdout_tool_call(&chunk, &mut emitted_tool_ids, &mut emitted_tool_signatures);
            let metadata = crate::agent_external::shared::complete_chunk_metadata(false, 
                codex_chunk_metadata(&value, &chunk),
                &chunk,
                &run_id,
                source_timestamp,
                source_sequence,
                source_subsequence as u32,
            );
            observe_codex_turn(&mut turn_events, &chunk, &metadata);
            emit_chunk_with_run_id_and_metadata(
                &app_handle,
                &chunk,
                AGENT_TYPE,
                &run_id,
                &metadata,
            );
        }

        match codex_run_signal(&value) {
            CodexRunSignal::TerminalCompleted => {
                terminal_signal = CodexRunSignal::TerminalCompleted;
                // terminal 只做标记,继续排空 stdout 到 EOF。正常完成的 stdout
                // 是本轮唯一可见数据源;EOF 后不得再用 rollout 补发工具。
            }
            CodexRunSignal::TerminalFailed => {
                // turn.failed 不提前: 它需要 Error chunk + 失败 reason, 由
                // run_codex 末尾据 exit status 发 StreamEnd(reason)。提前发 None
                // 会把 failed 误标成 completed。
                terminal_signal = CodexRunSignal::TerminalFailed;
            }
            CodexRunSignal::Continue => {}
        }
    }

    let mut reconciled_tool_chunks = 0usize;
    if should_reconcile_rollout(terminal_signal, stream_end_emitted.load(Ordering::Acquire)) {
        if let Some(session_id) = resolved_session_id.as_deref() {
            match get_rollout_tool_response_items_since(session_id, started_at_millis).await {
                Ok(events) => {
                    for (chunk, metadata) in reconcile_rollout_tool_events(
                        &emit_thread_id,
                        &events,
                        &emitted_tool_ids,
                        &mut emitted_tool_signatures,
                    ) {
                        if stream_end_emitted.load(Ordering::Acquire) {
                            break;
                        }
                        observe_codex_turn(&mut turn_events, &chunk, &metadata);
                        emit_chunk_with_run_id_and_metadata(
                            &app_handle,
                            &chunk,
                            AGENT_TYPE,
                            &run_id,
                            &metadata,
                        );
                        reconciled_tool_chunks += 1;
                    }
                }
                Err(err) => runtime_log::record_agent_event(
                    "warn",
                    "codex_stdout",
                    "codex.rollout_reconcile_failed",
                    "Failed to reconcile Codex rollout tool events",
                    Some(&thread_id),
                    Some(AGENT_TYPE),
                    Some(serde_json::json!({
                        "run_id": run_id,
                        "session_id": session_id,
                        "error": err,
                    })),
                ),
            }
        }
    }

    persist_turn_events(&thread_manager, &mut turn_events, &run_id).await;

    runtime_log::record_agent_event(
        "info",
        "codex_stdout",
        "codex.stdout_eof",
        "Codex stdout reached EOF",
        Some(&thread_id),
        Some(AGENT_TYPE),
        Some(serde_json::json!({
            "terminal_signal": match terminal_signal {
                CodexRunSignal::Continue => "none",
                CodexRunSignal::TerminalCompleted => "completed",
                CodexRunSignal::TerminalFailed => "failed",
            },
            "reconciled_tool_chunks": reconciled_tool_chunks,
            "blocked_post_completion_chunks": blocked_post_completion_chunks,
        })),
    );
    Ok(())
}

fn should_reconcile_rollout(terminal_signal: CodexRunSignal, stream_end_emitted: bool) -> bool {
    !stream_end_emitted && terminal_signal != CodexRunSignal::TerminalCompleted
}

fn should_emit_following_stdout_chunks(terminal_signal: CodexRunSignal) -> bool {
    terminal_signal != CodexRunSignal::TerminalCompleted
}

fn record_stdout_tool_call(
    chunk: &AgentChunk,
    emitted_tool_ids: &mut HashSet<String>,
    emitted_tool_signatures: &mut HashMap<String, usize>,
) {
    let AgentChunk::ToolCall {
        id, name, input, ..
    } = chunk
    else {
        return;
    };
    if !emitted_tool_ids.insert(id.clone()) {
        return;
    }
    let signature = tool_signature(name, input);
    *emitted_tool_signatures.entry(signature).or_default() += 1;
}

fn reconcile_rollout_tool_events(
    thread_id: &str,
    events: &[CodexRolloutEvent],
    stdout_tool_ids: &HashSet<String>,
    stdout_tool_signatures: &mut HashMap<String, usize>,
) -> Vec<(AgentChunk, AgentChunkMetadata)> {
    let mut chunks = Vec::new();
    let mut skipped_rollout_ids = HashSet::new();
    let mut rollout_tool_names = HashMap::new();

    for event in events {
        let payload = event.value.get("payload").unwrap_or(&event.value);
        let nested_exec_names = if payload.get("type").and_then(Value::as_str)
            == Some("custom_tool_call")
            && payload.get("name").and_then(Value::as_str) == Some("exec")
        {
            nested_exec_tool_names(payload)
        } else {
            Default::default()
        };
        let skip_nested_exec = !nested_exec_names.is_empty()
            && consume_all_tool_signatures(stdout_tool_signatures, &nested_exec_names);

        for (source_subsequence, mut chunk) in codex_event_to_chunks(thread_id, &event.value)
            .into_iter()
            .enumerate()
        {
            let metadata = crate::agent_external::shared::complete_chunk_metadata(false, 
                codex_chunk_metadata(&event.value, &chunk),
                &chunk,
                "rollout",
                event
                    .source_timestamp
                    .unwrap_or_else(|| chrono::Utc::now().timestamp_millis()),
                event.source_sequence,
                source_subsequence as u32,
            );
            match &mut chunk {
                AgentChunk::ToolCall {
                    id, name, input, ..
                } => {
                    let signature = tool_signature(name.as_str(), input);
                    let already_streamed = if stdout_tool_ids.contains(id.as_str()) {
                        if !skip_nested_exec {
                            consume_tool_signature(stdout_tool_signatures, &signature);
                        }
                        true
                    } else {
                        skip_nested_exec
                            || consume_tool_signature(stdout_tool_signatures, &signature)
                    };
                    if already_streamed {
                        skipped_rollout_ids.insert(id.clone());
                    } else {
                        rollout_tool_names.insert(id.clone(), name.clone());
                        chunks.push((chunk, metadata));
                    }
                }
                AgentChunk::ToolResult { id, name, .. } => {
                    if skipped_rollout_ids.contains(id.as_str())
                        || stdout_tool_ids.contains(id.as_str())
                    {
                        continue;
                    }
                    if let Some(tool_name) = rollout_tool_names.get(id.as_str()) {
                        *name = tool_name.clone();
                    }
                    // Paired results complete calls backfilled above. Result-only
                    // records are also useful: the frontend can create a completed
                    // row when a call record was absent or malformed.
                    chunks.push((chunk, metadata));
                }
                _ => {}
            }
        }
    }

    chunks
}

fn consume_all_tool_signatures(
    counts: &mut HashMap<String, usize>,
    names: &std::collections::BTreeSet<String>,
) -> bool {
    if names
        .iter()
        .any(|name| counts.get(name).copied().unwrap_or_default() == 0)
    {
        return false;
    }
    for name in names {
        consume_tool_signature(counts, name);
    }
    true
}

fn consume_tool_signature(counts: &mut HashMap<String, usize>, signature: &str) -> bool {
    let Some(count) = counts.get_mut(signature) else {
        return false;
    };
    if *count == 0 {
        return false;
    }
    *count -= 1;
    true
}

fn tool_signature(name: &str, input: &Value) -> String {
    match name {
        "command_execution" => "exec_command".to_string(),
        "file_change" => "apply_patch".to_string(),
        "image_generation" => "image_gen__imagegen".to_string(),
        "mcp_tool_call" => {
            let tool = input.get("tool").and_then(Value::as_str).unwrap_or(name);
            if tool.starts_with("mcp__") {
                return tool.to_string();
            }
            input
                .get("server")
                .and_then(Value::as_str)
                .filter(|server| !server.is_empty())
                .map(|server| format!("mcp__{server}__{tool}"))
                .unwrap_or_else(|| tool.to_string())
        }
        _ => name.to_string(),
    }
}

fn looks_like_codex_json_event_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with('{')
        && (trimmed.contains(r#""type":"item."#)
            || trimmed.contains(r#""type": "item."#)
            || trimmed.contains(r#""type":"event_msg""#)
            || trimmed.contains(r#""type": "event_msg""#)
            || trimmed.contains(r#""type":"turn."#)
            || trimmed.contains(r#""type": "turn."#)
            || trimmed.contains(r#""type":"thread."#)
            || trimmed.contains(r#""type": "thread."#)
            || trimmed.contains(r#""kind":"item."#)
            || trimmed.contains(r#""kind": "item."#))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CodexRunSignal {
    Continue,
    /// `turn.completed` / legacy `task_complete`: 成功完成。reader 继续排空
    /// stdout,但不再读取 rollout;随后由统一 tail 发送 StreamEnd。
    TerminalCompleted,
    /// `turn.failed` (非 reconnect): 失败, 需 Error chunk + 失败 reason, 走原
    /// tail 路径, 不提前结束 (避免把 failed 误标成 completed)。
    TerminalFailed,
}

pub(crate) fn codex_run_signal(value: &Value) -> CodexRunSignal {
    if is_transient_codex_reconnect_event(value) {
        return CodexRunSignal::Continue;
    }
    let event_type = value
        .get("type")
        .or_else(|| value.get("kind"))
        .and_then(Value::as_str);
    if event_type == Some("turn.failed") {
        return CodexRunSignal::TerminalFailed;
    }
    if is_codex_task_complete(value) {
        return CodexRunSignal::TerminalCompleted;
    }
    CodexRunSignal::Continue
}

pub(crate) fn is_codex_task_complete(value: &Value) -> bool {
    let event_type = value
        .get("type")
        .or_else(|| value.get("kind"))
        .and_then(Value::as_str);
    if matches!(event_type, Some("turn.completed" | "turn.failed")) {
        return true;
    }
    if event_type != Some("event_msg") {
        return false;
    }
    value
        .get("payload")
        .and_then(|payload| payload.get("type"))
        .and_then(Value::as_str)
        == Some("task_complete")
}

fn log_codex_stdout_event(thread_id: &str, line: &str, value: &Value) {
    let event_type = value
        .get("type")
        .or_else(|| value.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let item_type = value
        .get("item")
        .and_then(|item| item.get("type"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let item_id = value
        .get("item")
        .and_then(|item| item.get("id"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let command = value
        .get("item")
        .and_then(|item| item.get("command"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let output_chars = value
        .get("item")
        .and_then(|item| item.get("aggregated_output"))
        .and_then(Value::as_str)
        .map(|output| output.chars().count());

    runtime_log::record_agent_event(
        "info",
        "codex_stdout",
        "codex.stdout_event",
        "Codex stdout JSON event received",
        Some(thread_id),
        Some(AGENT_TYPE),
        Some(serde_json::json!({
            "event_type": event_type,
            "item_type": item_type,
            "item_id": item_id,
            "line_chars": line.chars().count(),
            "command": truncate_for_log(command),
            "aggregated_output_chars": output_chars,
        })),
    );
}

pub(crate) fn extract_session_id(value: &Value) -> Option<String> {
    let event_type = value
        .get("type")
        .or_else(|| value.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();

    for key in [
        "session_id",
        "sessionId",
        "conversation_id",
        "conversationId",
        "thread_id",
        "threadId",
    ] {
        if let Some(id) = value.get(key).and_then(Value::as_str) {
            return Some(id.to_string());
        }
    }

    if event_type.contains("session") {
        if let Some(id) = value.get("id").and_then(Value::as_str) {
            return Some(id.to_string());
        }
    }

    find_nested_session_id(value)
}

fn find_nested_session_id(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => {
            for key in ["session_id", "sessionId", "thread_id", "threadId"] {
                if let Some(id) = map.get(key).and_then(Value::as_str) {
                    return Some(id.to_string());
                }
            }
            map.values().find_map(find_nested_session_id)
        }
        Value::Array(items) => items.iter().find_map(find_nested_session_id),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compacts_codex_turn_events_into_message_snapshots() {
        let mut turn = CodexTurnEvents::default();
        let text_metadata = AgentChunkMetadata {
            message_id: Some("assistant-item-1".to_string()),
            message_phase: Some("updated"),
            content_mode: Some("snapshot"),
            ..Default::default()
        };
        observe_codex_turn(&mut turn, 
            &AgentChunk::Text {
                thread_id: "session-1".to_string(),
                text: "partial".to_string(),
            },
            &text_metadata,
        );
        observe_codex_turn(&mut turn, 
            &AgentChunk::Text {
                thread_id: "session-1".to_string(),
                text: "complete answer".to_string(),
            },
            &AgentChunkMetadata {
                message_phase: Some("completed"),
                ..text_metadata.clone()
            },
        );
        for command in ["pwd", "pwd -P"] {
            observe_codex_turn(&mut turn, 
                &AgentChunk::ToolCall {
                    thread_id: "session-1".to_string(),
                    id: "tool-1".to_string(),
                    name: "command_execution".to_string(),
                    input: serde_json::json!({ "command": command }),
                },
                &AgentChunkMetadata::default(),
            );
        }
        observe_codex_turn(&mut turn, 
            &AgentChunk::ToolResult {
                thread_id: "session-1".to_string(),
                id: "tool-1".to_string(),
                name: "command_execution".to_string(),
                result: serde_json::json!({ "output": "/tmp" }),
            },
            &AgentChunkMetadata::default(),
        );
        for total_tokens in [10, 20] {
            observe_codex_turn(&mut turn, 
                &AgentChunk::Usage {
                    thread_id: "session-1".to_string(),
                    model_id: None,
                    last_run_at: None,
                    usage: Some(crate::agent_flowix::UsageInfo {
                        total_tokens: Some(total_tokens),
                        ..Default::default()
                    }),
                    status_info: None,
                },
                &AgentChunkMetadata::default(),
            );
        }

        assert_eq!(turn.events.len(), 4);
        assert!(matches!(
            &turn.events[0],
            (
                AgentChunk::Text { text, .. },
                AgentChunkMetadata {
                    message_phase: Some("completed"),
                    content_mode: Some("snapshot"),
                    ..
                }
            ) if text == "complete answer"
        ));
        assert!(matches!(
            &turn.events[1].0,
            AgentChunk::ToolCall { input, .. }
                if input.get("command").and_then(Value::as_str) == Some("pwd -P")
        ));
        assert!(matches!(
            &turn.events[3].0,
            AgentChunk::Usage { usage: Some(usage), .. }
                if usage.total_tokens == Some(20)
        ));
    }

    #[tokio::test]
    async fn persists_session_chunks_under_the_product_thread() {
        let manager = ThreadManager::for_tests();
        let product_thread_id = "codex-local-card-storage";
        let session_id = "019f0000-0000-7000-8000-000000000456";
        manager
            .upsert_external_session(product_thread_id, AGENT_TYPE, session_id, None)
            .await
            .unwrap();
        persist_codex_chunk_with_metadata(
            &manager,
            &AgentChunk::Text {
                thread_id: session_id.to_string(),
                text: "stored once".to_string(),
            },
            "run-storage",
            None,
            &AgentChunkMetadata {
                message_id: Some("assistant-storage".to_string()),
                message_phase: Some("completed"),
                content_mode: Some("snapshot"),
                ..Default::default()
            },
        )
        .await;

        assert_eq!(
            manager
                .list_agent_external_events_by_thread(product_thread_id, None, 10)
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(manager
            .list_agent_external_events_by_thread(session_id, None, 10)
            .await
            .unwrap()
            .is_empty());
    }

    #[test]
    fn rollout_reconciliation_skips_streamed_nested_tools_and_backfills_pure_exec() {
        let stdout_call = AgentChunk::ToolCall {
            thread_id: "thread_1".to_string(),
            id: "item_1".to_string(),
            name: "command_execution".to_string(),
            input: serde_json::json!({ "command": "pwd" }),
        };
        let mut stdout_ids = HashSet::new();
        let mut stdout_signatures = HashMap::new();
        record_stdout_tool_call(&stdout_call, &mut stdout_ids, &mut stdout_signatures);
        let events = vec![
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call",
                    "call_id": "call_command",
                    "name": "exec",
                    "input": "const r = await tools.exec_command({cmd: 'pwd'}); text(r.output);"
                }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call_output",
                    "call_id": "call_command",
                    "output": "pwd output"
                }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call",
                    "call_id": "call_pure_exec",
                    "name": "exec",
                    "input": "ALL_TOOLS.filter(x => x.name.includes('browser')).forEach(text);"
                }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call_output",
                    "call_id": "call_pure_exec",
                    "output": "tool metadata"
                }
            }),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, value)| CodexRolloutEvent {
            value,
            source_sequence: index as u64,
            source_timestamp: Some(1_700_000_000_000 + index as i64),
        })
        .collect::<Vec<_>>();

        let chunks =
            reconcile_rollout_tool_events("thread_1", &events, &stdout_ids, &mut stdout_signatures);

        assert!(matches!(
            chunks.as_slice(),
            [
                (AgentChunk::ToolCall { id, name, .. }, call_metadata),
                (
                    AgentChunk::ToolResult {
                        id: result_id,
                        name: result_name,
                        ..
                    },
                    result_metadata
                )
            ] if id == "call_pure_exec"
                && result_id == id
                && name == "exec"
                && result_name == name
                && call_metadata.message_id.as_deref() == Some("tool-call_pure_exec")
                && result_metadata.message_id == call_metadata.message_id
                && call_metadata.source_sequence == Some(2)
        ));
    }

    #[test]
    fn rollout_reconciliation_is_disabled_after_normal_completion() {
        assert!(!should_reconcile_rollout(
            CodexRunSignal::TerminalCompleted,
            false
        ));
        assert!(should_reconcile_rollout(CodexRunSignal::Continue, false));
        assert!(should_reconcile_rollout(
            CodexRunSignal::TerminalFailed,
            false
        ));
        assert!(!should_reconcile_rollout(CodexRunSignal::Continue, true));
        assert!(!should_emit_following_stdout_chunks(
            CodexRunSignal::TerminalCompleted
        ));
        assert!(should_emit_following_stdout_chunks(
            CodexRunSignal::TerminalFailed
        ));
    }

    #[test]
    fn detects_task_complete_and_turn_terminal_events() {
        let legacy = serde_json::json!({
            "type": "event_msg",
            "payload": { "type": "task_complete" }
        });
        let completed = serde_json::json!({ "type": "turn.completed" });
        let failed = serde_json::json!({
            "type": "turn.failed",
            "error": { "message": "stream disconnected before completion" }
        });

        assert!(is_codex_task_complete(&legacy));
        assert_eq!(codex_run_signal(&legacy), CodexRunSignal::TerminalCompleted);
        assert_eq!(
            codex_run_signal(&completed),
            CodexRunSignal::TerminalCompleted
        );
        assert_eq!(codex_run_signal(&failed), CodexRunSignal::TerminalFailed);
    }

    #[test]
    fn reconnecting_turn_failed_is_not_terminal() {
        let reconnecting = serde_json::json!({
            "type": "turn.failed",
            "error": { "message": "stream disconnected before completion; Reconnecting..." }
        });

        assert!(is_codex_task_complete(&reconnecting));
        assert_eq!(codex_run_signal(&reconnecting), CodexRunSignal::Continue);
    }

    #[test]
    fn extracts_nested_session_id_from_stream_event() {
        let value = serde_json::json!({
            "type": "event_msg",
            "payload": {
                "session": {
                    "thread_id": "019ed38f-e9e3-7b61-8be3-80a40788d6e3"
                }
            }
        });

        assert_eq!(
            extract_session_id(&value).as_deref(),
            Some("019ed38f-e9e3-7b61-8be3-80a40788d6e3")
        );
    }

    #[test]
    fn detects_malformed_codex_event_lines() {
        let malformed = r#"{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":""C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'rg --files .'"}}"#;
        assert!(looks_like_codex_json_event_line(malformed));
        assert!(!looks_like_codex_json_event_line("plain stderr output"));
    }
}
