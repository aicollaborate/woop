use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;

use tokio::io::BufReader;

use super::events::{
    claude_chunk_metadata, claude_event_timestamp_millis, parse_claude_stdout_line_with_state,
    ClaudeStreamState, ParsedClaudeStdoutLine,
};
use super::AGENT_TYPE;
use crate::agent_external::{
    emit_chunk_with_run_id_and_metadata, persist_and_emit_external_chunk,
    persist_external_chunk_for_thread_with_metadata, read_capped_line, truncate_for_log,
    AgentChunkMetadata, ExternalRunRegistry, StreamingEmitBuffer, MAX_STDOUT_LINE_BYTES,
    STREAM_FLUSH_INTERVAL, STREAM_FLUSH_MAX_BYTES,
};
use crate::agent_flowix::AgentChunk;
use crate::agent_session::ThreadManager;
use crate::runtime_log;
use crate::agent_external::shared::TurnEvents;

type ClaudeTurnEvents = TurnEvents;

/// Claude text merge: append streaming deltas, but a `snapshot` content_mode
/// replaces the whole row (Claude sends full snapshots mid-stream).
fn observe_claude_turn(
    te: &mut TurnEvents,
    chunk: &AgentChunk,
    metadata: &AgentChunkMetadata,
    run_id: &str,
) {
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
            let message_id = metadata.message_id.clone().unwrap_or_else(|| {
                te.next_message_id += 1;
                format!("claude-{run_id}-{role}-{}", te.next_message_id)
            });
            let key = format!("{role}:{message_id}");
            if let Some(index) = te.message_indexes.get(&key).copied() {
                let replace = metadata.content_mode == Some("snapshot");
                match (&mut te.events[index].0, chunk) {
                    (AgentChunk::Text { text: stored, .. }, AgentChunk::Text { text, .. })
                    | (
                        AgentChunk::Reasoning { text: stored, .. },
                        AgentChunk::Reasoning { text, .. },
                    ) => {
                        if replace {
                            *stored = text.clone();
                        } else {
                            stored.push_str(text);
                        }
                    }
                    _ => {}
                }
                return;
            }
            let mut stored_metadata = metadata.clone();
            stored_metadata.message_id = Some(message_id);
            stored_metadata.content_mode = Some("snapshot");
            stored_metadata.message_phase = Some("completed");
            te.message_indexes.insert(key, te.events.len());
            te.events.push((chunk.clone(), stored_metadata));
        }
        AgentChunk::ToolCall { .. } => te.observe_tool_call(chunk, metadata),
        AgentChunk::ToolResult { .. } => te.observe_tool_result(chunk, metadata),
        AgentChunk::Usage { .. } => te.observe_usage(chunk, metadata),
        AgentChunk::Error { .. } => te.observe_error(chunk, metadata),
        _ => {}
    }
}


/// Flush the frame buffer to the live UI and fold it into the turn snapshot.
/// Database persistence happens once at the end of the turn.
async fn flush_emit_buffer(
    app_handle: &tauri::AppHandle,
    emit_buf: &mut StreamingEmitBuffer,
    turn_events: &mut ClaudeTurnEvents,
    run_id: &str,
) {
    if emit_buf.is_empty() {
        return;
    }
    for (chunk, metadata) in emit_buf.flush_with_metadata() {
        observe_claude_turn(&mut *turn_events, &chunk, &metadata, run_id);
        emit_chunk_with_run_id_and_metadata(app_handle, &chunk, AGENT_TYPE, run_id, &metadata);
    }
}

/// burst 保险 ── 缓冲超过 [`STREAM_FLUSH_MAX_BYTES`] 时立�?flush 并重�?��计时,
/// 防�?持续高速文�?��时缓冲无限�?长。�?常一帧的文本量远小于此阈�? �?��
/// read_capped_line 持续返回高�? text 行的极�? burst 才会触达�?
async fn flush_emit_buffer_if_full(
    app_handle: &tauri::AppHandle,
    emit_buf: &mut StreamingEmitBuffer,
    turn_events: &mut ClaudeTurnEvents,
    run_id: &str,
    last_flush_at: &mut Instant,
) {
    if emit_buf.pending_bytes() >= STREAM_FLUSH_MAX_BYTES {
        flush_emit_buffer(app_handle, emit_buf, turn_events, run_id).await;
        *last_flush_at = Instant::now();
    }
}

async fn persist_turn_events(
    thread_manager: &Arc<ThreadManager>,
    thread_id: &str,
    turn_events: &mut ClaudeTurnEvents,
    run_id: &str,
) {
    let storage_thread_id = thread_manager
        .find_thread_by_external_session(thread_id, AGENT_TYPE)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| thread_id.to_string());
    for (chunk, metadata) in std::mem::take(turn_events).events {
        persist_external_chunk_for_thread_with_metadata(
            thread_manager,
            AGENT_TYPE,
            &storage_thread_id,
            &chunk,
            run_id,
            None,
            &metadata,
        )
        .await;
    }
}

pub(crate) async fn read_claude_stdout<R>(
    thread_id: String,
    run_id: String,
    app_handle: tauri::AppHandle,
    thread_manager: Arc<ThreadManager>,
    runs: ExternalRunRegistry,
    reader: BufReader<R>,
) -> Result<(), String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut reader = reader;
    let mut seen_sessions = HashSet::new();
    // tool_use_id -> tool_name 跨�?映射。ToolCall chunk 发出时�?�?id->name,
    // 后续 ToolResult chunk 到达时用它填入真实工具名,避免前�? name="" fallback "unknown tool"�?
    let mut tool_names: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    // partial 模式跨�?状�?── �?�� tool_use �?input_json_delta 分片, �?    // content_block_stop flush �?ToolCall。�? events::ClaudeStreamState�?
    let mut stream_state = ClaudeStreamState::default();
    // 帧级文本合并 buffer ── 把高�?Text / Reasoning 攒批, 减少 agent-chunk IPC
    // emit 次数 (�?StreamingEmitBuffer doc)。Text/Reasoning �?buffer; 其它 chunk
    // �?flush �?emit, 保证呈现顺序�?
    let mut emit_buf = StreamingEmitBuffer::new(thread_id.clone());
    let mut turn_events = ClaudeTurnEvents::default();
    // 帧级 flush 计时 ── 与前�?rAF 帧率 (~16ms) 对齐。每读完一整�?检�?elapsed,
    // burst 期间约每�?flush 一欰�?    //
    // 不用 select! + interval: read_capped_line �?> BufReader 容量 (8 KiB) 的长�?    // 时会跨�?�?fill_buf �?�� out, select! 在中�?drop �?future 会丢失已�?��的部�?    // �?(reader cursor �?consume �?out �?��), 导致�?tool_result 行损�?-> JSON
    // 解析失败�?�� non_json 文本回显�?行末时间检�?�?read_capped_line 完整返回一
    // 行后才�?查时�? �?drop 风险�?
    let mut last_flush_at = Instant::now();
    let mut source_sequence = 0u64;

    loop {
        let line_opt = match read_capped_line(&mut reader, MAX_STDOUT_LINE_BYTES).await {
            Ok(opt) => opt,
            Err(err) => {
                // 绠￠亾寮傚父: 灏介噺 flush 宸叉敹鍒扮殑鏂囨湰鍐嶄笂鎶涖€?
                flush_emit_buffer(&app_handle, &mut emit_buf, &mut turn_events, &run_id).await;
                persist_turn_events(&thread_manager, &thread_id, &mut turn_events, &run_id).await;
                return Err(err);
            }
        };
        let Some((raw, truncated_by_reader)) = line_opt else {
            // EOF: 必须在返回前 flush 残留文本 ── 否则 spawn tail �?
            // emit_stream_end_once 浼氬厛浜庡熬閮ㄦ枃鏈埌杈惧墠绔€?
            flush_emit_buffer(&app_handle, &mut emit_buf, &mut turn_events, &run_id).await;
            break;
        };
        if truncated_by_reader {
            runtime_log::record_agent_event(
                "warn",
                "claude_stdout",
                "claude.stdout_line_truncated",
                "Claude stdout line exceeded reader limit and was truncated",
                Some(&thread_id),
                Some(AGENT_TYPE),
                Some(serde_json::json!({
                    "run_id": run_id,
                    "line_bytes_limit": MAX_STDOUT_LINE_BYTES,
                    "line_preview": truncate_for_log(raw.trim()),
                })),
            );
        }
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        source_sequence = source_sequence.saturating_add(1);
        // dev-only: 鎶婂瓙杩涚▼ stdout 鍘熷琛岄暅鍍忓埌 ~/.flowix/debug/, 1:1 杩樺師
        // vendor CLI 回包供排障。release 构建�?no-op, 不落盘�?
        runtime_log::dump_debug_stdout_line(AGENT_TYPE, &thread_id, &run_id, line);
        runs.touch(&thread_id, Some(&run_id)).await;

        let parsed = parse_claude_stdout_line_with_state(&thread_id, line, &mut stream_state);
        let value = match parsed.value {
            Some(value) => value,
            None => {
                let Some(text) = non_json_stdout_text(&parsed, line) else {
                    runtime_log::record_agent_event(
                        "debug",
                        "claude_stdout",
                        "claude.stdout_non_json_dropped",
                        "Claude stdout emitted a JSON-like line that was intentionally dropped",
                        Some(&thread_id),
                        Some(AGENT_TYPE),
                        Some(serde_json::json!({
                            "run_id": run_id,
                            "line_chars": line.chars().count(),
                            "line_preview": truncate_for_log(line),
                        })),
                    );
                    continue;
                };
                let line_chars = line.chars().count();
                runtime_log::record_agent_event(
                    "warn",
                    "claude_stdout",
                    "claude.stdout_non_json",
                    "Claude stdout emitted a non-JSON line",
                    Some(&thread_id),
                    Some(AGENT_TYPE),
                    Some(serde_json::json!({
                        "run_id": run_id,
                        "line_chars": line_chars,
                        "line_preview": truncate_for_log(line),
                    })),
                );
                // �?JSON 行作为文�?���?── �?buffer 合并 (最多延迟一�?�?
                let chunk = AgentChunk::Text {
                    thread_id: thread_id.clone(),
                    text: text.clone(),
                };
                let metadata = crate::agent_external::shared::complete_chunk_metadata(true, 
                    AgentChunkMetadata {
                        message_phase: Some("updated"),
                        content_mode: Some("delta"),
                        ..Default::default()
                    },
                    &chunk,
                    &run_id,
                    chrono::Utc::now().timestamp_millis(),
                    source_sequence,
                    0,
                );
                if emit_buf.has_text()
                    && emit_buf.text_message_id() != metadata.message_id.as_deref()
                {
                    flush_emit_buffer(&app_handle, &mut emit_buf, &mut turn_events, &run_id).await;
                    last_flush_at = Instant::now();
                }
                emit_buf.append_text_with_metadata(&text, metadata);
                flush_emit_buffer_if_full(
                    &app_handle,
                    &mut emit_buf,
                    &mut turn_events,
                    &run_id,
                    &mut last_flush_at,
                )
                .await;
                continue;
            }
        };

        if let Some(session_id) = parsed.session_id {
            if seen_sessions.insert(session_id.clone()) {
                runtime_log::record_agent_event(
                    "info",
                    "claude_stdout",
                    "claude.session_resolved",
                    "Claude Code reported a session id",
                    Some(&thread_id),
                    Some(AGENT_TYPE),
                    Some(serde_json::json!({
                        "run_id": run_id,
                        "session_id": session_id,
                    })),
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
                        "claude_stdout",
                        "claude.session_persist_failed",
                        "Failed to persist Claude external session mapping",
                        Some(&thread_id),
                        Some(AGENT_TYPE),
                        Some(serde_json::json!({
                            "run_id": run_id,
                            "session_id": session_id,
                            "error": err.to_string(),
                        })),
                    );
                    tracing::warn!(
                        "[ClaudeCli] failed to persist external session mapping for {thread_id}: {err}"
                    );
                }
                // SessionResolved �?��文本 chunk ── �?flush 文本 buffer, 保证它之�?
                // 的文�?��落地, �?emit�?
                flush_emit_buffer(&app_handle, &mut emit_buf, &mut turn_events, &run_id).await;
                last_flush_at = Instant::now();
                let chunk = AgentChunk::SessionResolved {
                    thread_id: thread_id.clone(),
                    session_id: session_id.clone(),
                };
                persist_and_emit_external_chunk(
                    &app_handle,
                    &thread_manager,
                    AGENT_TYPE,
                    &chunk,
                    &run_id,
                    None,
                )
                .await;
                runs.set_session_id(&thread_id, Some(&run_id), session_id.clone())
                    .await;
            }
        }

        let source_timestamp = claude_event_timestamp_millis(&value)
            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
        for (source_subsequence, chunk) in parsed.chunks.into_iter().enumerate() {
            let metadata = crate::agent_external::shared::complete_chunk_metadata(true, 
                claude_chunk_metadata(&value, &chunk, &stream_state),
                &chunk,
                &run_id,
                source_timestamp,
                source_sequence,
                source_subsequence as u32,
            );
            match chunk {
                AgentChunk::Text { text, .. } => {
                    if emit_buf.has_text()
                        && emit_buf.text_message_id() != metadata.message_id.as_deref()
                    {
                        flush_emit_buffer(&app_handle, &mut emit_buf, &mut turn_events, &run_id)
                            .await;
                        last_flush_at = Instant::now();
                    }
                    emit_buf.append_text_with_metadata(&text, metadata);
                    flush_emit_buffer_if_full(
                        &app_handle,
                        &mut emit_buf,
                        &mut turn_events,
                        &run_id,
                        &mut last_flush_at,
                    )
                    .await;
                }
                AgentChunk::Reasoning { text, .. } => {
                    if emit_buf.has_reasoning()
                        && emit_buf.reasoning_message_id() != metadata.message_id.as_deref()
                    {
                        flush_emit_buffer(&app_handle, &mut emit_buf, &mut turn_events, &run_id)
                            .await;
                        last_flush_at = Instant::now();
                    }
                    emit_buf.append_reasoning_with_metadata(&text, metadata);
                    flush_emit_buffer_if_full(
                        &app_handle,
                        &mut emit_buf,
                        &mut turn_events,
                        &run_id,
                        &mut last_flush_at,
                    )
                    .await;
                }
                mut chunk => {
                    // 非文�?chunk ── �?flush 文本 buffer, 保证
                    // text -> tool_call -> text -> tool_result 的呈现顺�? �?emit�?
                    flush_emit_buffer(&app_handle, &mut emit_buf, &mut turn_events, &run_id).await;
                    last_flush_at = Instant::now();
                    // ToolCall 发出前�?�?id -> name
                    if let AgentChunk::ToolCall {
                        ref id, ref name, ..
                    } = chunk
                    {
                        if !id.is_empty() && !name.is_empty() {
                            tool_names.insert(id.clone(), name.clone());
                        }
                    }
                    // ToolResult �?tool_use_id 查回真实工具�?�?�� name 字�?
                    if let AgentChunk::ToolResult {
                        ref id,
                        ref mut name,
                        ..
                    } = chunk
                    {
                        if name.is_empty() {
                            if let Some(real_name) = tool_names.get(id) {
                                *name = real_name.clone();
                            }
                        }
                    }
                    observe_claude_turn(&mut turn_events, &chunk, &metadata, &run_id);
                    emit_chunk_with_run_id_and_metadata(
                        &app_handle,
                        &chunk,
                        AGENT_TYPE,
                        &run_id,
                        &metadata,
                    );
                }
            }
        }

        // 帧级 flush ── 这一行�?理完, 若距上�? flush 已过一�? 落地缓冲文本�?        // burst 期间约每 16ms flush 一�?(与前�?rAF 对齐); 非文�?chunk 已在上面
        // 寮哄埗 flush, 杩欓噷涓昏鍏滄寔缁枃鏈祦鐨勬敀鎵广€傝娴佸仠椤挎椂 read_capped_line 闃诲,
        // 缓冲里最多残留一帧文�? 由下一�?/ EOF / 工具调用触发落地�?
        if last_flush_at.elapsed() >= STREAM_FLUSH_INTERVAL {
            flush_emit_buffer(&app_handle, &mut emit_buf, &mut turn_events, &run_id).await;
            last_flush_at = Instant::now();
        }
    }
    persist_turn_events(&thread_manager, &thread_id, &mut turn_events, &run_id).await;
    runtime_log::record_agent_event(
        "info",
        "claude_stdout",
        "claude.stdout_eof",
        "Claude stdout reached EOF",
        Some(&thread_id),
        Some(AGENT_TYPE),
        None,
    );
    Ok(())
}

fn non_json_stdout_text(parsed: &ParsedClaudeStdoutLine, line: &str) -> Option<String> {
    if parsed.chunks.is_empty() {
        return None;
    }

    let text = parsed
        .chunks
        .iter()
        .filter_map(|chunk| match chunk {
            AgentChunk::Text { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<String>();

    if text.is_empty() {
        Some(format!("{line}\n"))
    } else {
        Some(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turn_events_compact_claude_deltas_into_message_snapshots() {
        let mut turn = ClaudeTurnEvents::default();
        let metadata = AgentChunkMetadata {
            message_id: Some("assistant-message-1-block-0".to_string()),
            message_phase: Some("updated"),
            content_mode: Some("delta"),
            ..Default::default()
        };
        for text in ["hello ", "world"] {
            observe_claude_turn(&mut turn, 
                &AgentChunk::Text {
                    thread_id: "thread-1".to_string(),
                    text: text.to_string(),
                },
                &metadata,
                "run-1",
            );
        }
        observe_claude_turn(&mut turn, 
            &AgentChunk::ToolCall {
                thread_id: "thread-1".to_string(),
                id: "call-1".to_string(),
                name: "Read".to_string(),
                input: serde_json::json!({"file_path": "/tmp/a"}),
            },
            &AgentChunkMetadata::default(),
            "run-1",
        );

        assert_eq!(turn.events.len(), 2);
        assert!(matches!(
            &turn.events[0].0,
            AgentChunk::Text { text, .. } if text == "hello world"
        ));
        assert_eq!(turn.events[0].1.content_mode, Some("snapshot"));
        assert_eq!(turn.events[0].1.message_phase, Some("completed"));
    }

    #[test]
    fn reasoning_metadata_is_stable_across_claude_provider_messages_in_one_run() {
        let chunk = AgentChunk::Reasoning {
            thread_id: "thread-1".to_string(),
            text: "thinking".to_string(),
        };
        let first = crate::agent_external::shared::complete_chunk_metadata(true, 
            AgentChunkMetadata {
                message_id: Some("reasoning-provider-message-1-block-0".to_string()),
                ..Default::default()
            },
            &chunk,
            "run-1",
            100,
            1,
            0,
        );
        let second = crate::agent_external::shared::complete_chunk_metadata(true, 
            AgentChunkMetadata {
                message_id: Some("reasoning-provider-message-2-block-0".to_string()),
                ..Default::default()
            },
            &chunk,
            "run-1",
            200,
            20,
            0,
        );

        assert_eq!(first.message_id.as_deref(), Some("reasoning-run-1"));
        assert_eq!(second.message_id, first.message_id);
        assert_eq!(first.source_sequence, Some(1));
        assert_eq!(second.source_sequence, Some(20));
    }

    #[test]
    fn parsed_claude_tool_cycles_share_one_run_scoped_reasoning_id() {
        let mut state = ClaudeStreamState::default();
        let first_start = r#"{"type":"stream_event","event":{"type":"message_start","message":{"id":"provider-message-1"}}}"#;
        let first_delta = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"first thought"}}}"#;
        let second_start = r#"{"type":"stream_event","event":{"type":"message_start","message":{"id":"provider-message-2"}}}"#;
        let second_delta = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"second thought"}}}"#;

        let parsed = parse_claude_stdout_line_with_state("thread-1", first_start, &mut state);
        assert!(parsed.chunks.is_empty());
        let first = parse_claude_stdout_line_with_state("thread-1", first_delta, &mut state);
        let first_value = first.value.as_ref().expect("first delta value");
        let first_chunk = first.chunks.first().expect("first reasoning chunk");
        let first_raw = claude_chunk_metadata(first_value, first_chunk, &state);
        assert_eq!(
            first_raw.message_id.as_deref(),
            Some("reasoning-provider-message-1-block-0")
        );
        let first_metadata =
            crate::agent_external::shared::complete_chunk_metadata(true, first_raw, first_chunk, "run-1", 100, 1, 0);

        let parsed = parse_claude_stdout_line_with_state("thread-1", second_start, &mut state);
        assert!(parsed.chunks.is_empty());
        let second = parse_claude_stdout_line_with_state("thread-1", second_delta, &mut state);
        let second_value = second.value.as_ref().expect("second delta value");
        let second_chunk = second.chunks.first().expect("second reasoning chunk");
        let second_raw = claude_chunk_metadata(second_value, second_chunk, &state);
        assert_eq!(
            second_raw.message_id.as_deref(),
            Some("reasoning-provider-message-2-block-0")
        );
        let second_metadata =
            crate::agent_external::shared::complete_chunk_metadata(true, second_raw, second_chunk, "run-1", 200, 2, 0);

        assert_eq!(
            first_metadata.message_id.as_deref(),
            Some("reasoning-run-1")
        );
        assert_eq!(second_metadata.message_id, first_metadata.message_id);
    }

    #[test]
    fn truncate_for_log_marks_long_output() {
        let text = "x".repeat(2050);
        let truncated = truncate_for_log(&text);

        assert!(truncated.ends_with("\n...[truncated]"));
        assert_eq!(
            truncated
                .trim_end_matches("\n...[truncated]")
                .chars()
                .count(),
            2048
        );
    }

    #[test]
    fn non_json_stdout_text_drops_malformed_claude_skill_event() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Base directory for this skill: C:\Users\Administrator\AppData\Local\Temp\claude\bundled-skills\2.1.199\2e69ace9e17316f996ad08e77f1a5312\claude-api\n\n# Building LLM-Powered Applications with Claude"}]}}"#;
        let mut state = ClaudeStreamState::default();
        let parsed = parse_claude_stdout_line_with_state("thread_1", line, &mut state);

        assert!(parsed.value.is_none());
        assert!(parsed.chunks.is_empty());
        assert_eq!(non_json_stdout_text(&parsed, line), None);
    }

    #[test]
    fn non_json_stdout_text_keeps_plain_stdout() {
        let parsed = ParsedClaudeStdoutLine {
            value: None,
            session_id: None,
            chunks: vec![AgentChunk::Text {
                thread_id: "thread_1".to_string(),
                text: "plain progress\n".to_string(),
            }],
        };

        assert_eq!(
            non_json_stdout_text(&parsed, "plain progress"),
            Some("plain progress\n".to_string())
        );
    }
}
