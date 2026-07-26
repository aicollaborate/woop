use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;

use tokio::io::BufReader;

use super::events::{
    parse_claude_stdout_line_with_state, ClaudeStreamState, ParsedClaudeStdoutLine,
};
use super::AGENT_TYPE;
use crate::agent_external::{
    persist_and_emit_external_chunk, read_capped_line, truncate_for_log, ExternalRunRegistry,
    StreamingEmitBuffer, MAX_STDOUT_LINE_BYTES, STREAM_FLUSH_INTERVAL, STREAM_FLUSH_MAX_BYTES,
};
use crate::agent_flowix::AgentChunk;
use crate::agent_session::ThreadManager;
use crate::runtime_log;

/// flush `emit_buf` 的全部缓�?chunk 并逐条 emit。空缓冲�?no-op�?
async fn flush_emit_buffer(
    app_handle: &tauri::AppHandle,
    thread_manager: &Arc<ThreadManager>,
    emit_buf: &mut StreamingEmitBuffer,
    run_id: &str,
) {
    if emit_buf.is_empty() {
        return;
    }
    for chunk in emit_buf.flush() {
        persist_and_emit_external_chunk(
            app_handle,
            thread_manager,
            AGENT_TYPE,
            &chunk,
            run_id,
            None,
        )
        .await;
    }
}

/// burst 保险 ── 缓冲超过 [`STREAM_FLUSH_MAX_BYTES`] 时立�?flush 并重�?��计时,
/// 防�?持续高速文�?��时缓冲无限�?长。�?常一帧的文本量远小于此阈�? �?��
/// read_capped_line 持续返回高�? text 行的极�? burst 才会触达�?
async fn flush_emit_buffer_if_full(
    app_handle: &tauri::AppHandle,
    thread_manager: &Arc<ThreadManager>,
    emit_buf: &mut StreamingEmitBuffer,
    run_id: &str,
    last_flush_at: &mut Instant,
) {
    if emit_buf.pending_bytes() >= STREAM_FLUSH_MAX_BYTES {
        flush_emit_buffer(app_handle, thread_manager, emit_buf, run_id).await;
        *last_flush_at = Instant::now();
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
    // 帧级 flush 计时 ── 与前�?rAF 帧率 (~16ms) 对齐。每读完一整�?检�?elapsed,
    // burst 期间约每�?flush 一欰�?    //
    // 不用 select! + interval: read_capped_line �?> BufReader 容量 (8 KiB) 的长�?    // 时会跨�?�?fill_buf �?�� out, select! 在中�?drop �?future 会丢失已�?��的部�?    // �?(reader cursor �?consume �?out �?��), 导致�?tool_result 行损�?-> JSON
    // 解析失败�?�� non_json 文本回显�?行末时间检�?�?read_capped_line 完整返回一
    // 行后才�?查时�? �?drop 风险�?
    let mut last_flush_at = Instant::now();

    loop {
        let line_opt = match read_capped_line(&mut reader, MAX_STDOUT_LINE_BYTES).await {
            Ok(opt) => opt,
            Err(err) => {
                // 绠￠亾寮傚父: 灏介噺 flush 宸叉敹鍒扮殑鏂囨湰鍐嶄笂鎶涖€?
                flush_emit_buffer(&app_handle, &thread_manager, &mut emit_buf, &run_id).await;
                return Err(err);
            }
        };
        let Some((raw, truncated_by_reader)) = line_opt else {
            // EOF: 必须在返回前 flush 残留文本 ── 否则 spawn tail �?
            // emit_stream_end_once 浼氬厛浜庡熬閮ㄦ枃鏈埌杈惧墠绔€?
            flush_emit_buffer(&app_handle, &thread_manager, &mut emit_buf, &run_id).await;
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
                emit_buf.append_text(&text);
                flush_emit_buffer_if_full(
                    &app_handle,
                    &thread_manager,
                    &mut emit_buf,
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
                flush_emit_buffer(&app_handle, &thread_manager, &mut emit_buf, &run_id).await;
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

        for chunk in parsed.chunks {
            match chunk {
                AgentChunk::Text { text, .. } => {
                    emit_buf.append_text(&text);
                    flush_emit_buffer_if_full(
                        &app_handle,
                        &thread_manager,
                        &mut emit_buf,
                        &run_id,
                        &mut last_flush_at,
                    )
                    .await;
                }
                AgentChunk::Reasoning { text, .. } => {
                    emit_buf.append_reasoning(&text);
                    flush_emit_buffer_if_full(
                        &app_handle,
                        &thread_manager,
                        &mut emit_buf,
                        &run_id,
                        &mut last_flush_at,
                    )
                    .await;
                }
                mut chunk => {
                    // 非文�?chunk ── �?flush 文本 buffer, 保证
                    // text -> tool_call -> text -> tool_result 的呈现顺�? �?emit�?
                    flush_emit_buffer(&app_handle, &thread_manager, &mut emit_buf, &run_id).await;
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
                    persist_and_emit_external_chunk(
                        &app_handle,
                        &thread_manager,
                        AGENT_TYPE,
                        &chunk,
                        &run_id,
                        None,
                    )
                    .await;
                }
            }
        }

        // 帧级 flush ── 这一行�?理完, 若距上�? flush 已过一�? 落地缓冲文本�?        // burst 期间约每 16ms flush 一�?(与前�?rAF 对齐); 非文�?chunk 已在上面
        // 寮哄埗 flush, 杩欓噷涓昏鍏滄寔缁枃鏈祦鐨勬敀鎵广€傝娴佸仠椤挎椂 read_capped_line 闃诲,
        // 缓冲里最多残留一帧文�? 由下一�?/ EOF / 工具调用触发落地�?
        if last_flush_at.elapsed() >= STREAM_FLUSH_INTERVAL {
            flush_emit_buffer(&app_handle, &thread_manager, &mut emit_buf, &run_id).await;
            last_flush_at = Instant::now();
        }
    }
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
