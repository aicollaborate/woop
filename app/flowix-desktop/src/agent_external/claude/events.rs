use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

use crate::agent_external::AgentChunkMetadata;
use crate::agent_flowix::AgentChunk;
use crate::agent_types::UsageInfo;

pub(crate) struct ParsedClaudeStdoutLine {
    pub value: Option<Value>,
    pub session_id: Option<String>,
    pub chunks: Vec<AgentChunk>,
}

/// `--include-partial-messages` 模式�? Claude Code 把一�?assistant 回答拆成
/// 多条 `stream_event`(Anthropic 原生流式事件)增量输出。其�?`tool_use` 块的
/// `input` JSON 閫氳繃 `input_json_delta` 鍒嗙墖鍒拌揪, 鍗曡瑙ｆ瀽鏃犳硶杩樺師瀹屾暣 input,
/// 必须跨�?�?�� ── �?��构持有这�?��行状�? �?`read_claude_stdout` �?��按会�?/// 保存, 传入 `claude_event_to_chunks_with_state`�?///
/// 镜像 OpenAI 兼�? provider �?`PendingToolCalls`(BTreeMap �?content_block
/// `index` �?�� `arguments`), 仅作用于 Claude partial 流式�?���?
#[derive(Default)]
pub(crate) struct ClaudeStreamState {
    current_message_id: Option<String>,
    /// content_block `index` -> �?���?�� tool_use 输入�?
    /// `content_block_start`(tool_use) �?entry;`input_json_delta` 追加
    /// `partial_json`;`content_block_stop` flush 鎴?`AgentChunk::ToolCall`銆?
    pending_tool_inputs: BTreeMap<i64, PendingToolInput>,
    /// 已发出 ToolCall 的 tool_use_id 集合 —— 跨行去重,防止 stream_event 增量与
    /// 完整 assistant 快照对同一 id 重复发 ToolCall。partial 模式下内置工具
    /// (WebSearch / Agent / TaskOutput 等无 stream_event 增量的工具)只出现在完整
    /// 快照里,靠本集合判定"是否已被增量发过"以决定是否从快照补发。
    emitted_tool_call_ids: HashSet<String>,
}

pub(crate) fn claude_chunk_metadata(
    value: &Value,
    chunk: &AgentChunk,
    state: &ClaudeStreamState,
) -> AgentChunkMetadata {
    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let block_index = value
        .get("event")
        .and_then(|event| event.get("index"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let embedded_message_id = value
        .pointer("/event/message/id")
        .or_else(|| value.pointer("/message/id"))
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string);
    // `stream_event` envelopes carry a different top-level UUID on every
    // delta. The stable provider id for those deltas comes from the prior
    // `message_start`, stored in `current_message_id`. Snapshot-style
    // assistant events may still use their top-level UUID as a fallback.
    let source_message_id = if event_type == "stream_event" {
        embedded_message_id.or_else(|| state.current_message_id.clone())
    } else {
        embedded_message_id
            .or_else(|| {
                value
                    .get("uuid")
                    .and_then(Value::as_str)
                    .filter(|id| !id.trim().is_empty())
                    .map(str::to_string)
            })
            .or_else(|| state.current_message_id.clone())
    };

    match chunk {
        AgentChunk::Text { .. } => AgentChunkMetadata {
            message_id: source_message_id.map(|id| format!("assistant-{id}-block-{block_index}")),
            message_phase: Some("updated"),
            content_mode: Some(if event_type == "stream_event" {
                "delta"
            } else {
                "snapshot"
            }),
            ..Default::default()
        },
        AgentChunk::Reasoning { .. } => AgentChunkMetadata {
            message_id: source_message_id.map(|id| format!("reasoning-{id}-block-{block_index}")),
            message_phase: Some("updated"),
            content_mode: Some(if event_type == "stream_event" {
                "delta"
            } else {
                "snapshot"
            }),
            ..Default::default()
        },
        AgentChunk::ToolCall { id, .. } => AgentChunkMetadata {
            message_id: Some(format!("tool-{id}")),
            message_phase: Some("started"),
            ..Default::default()
        },
        AgentChunk::ToolResult { id, .. } => AgentChunkMetadata {
            message_id: Some(format!("tool-{id}")),
            message_phase: Some("completed"),
            ..Default::default()
        },
        _ => AgentChunkMetadata::default(),
    }
}

pub(crate) fn claude_event_timestamp_millis(value: &Value) -> Option<i64> {
    let timestamp = value.get("timestamp")?;
    if let Some(value) = timestamp.as_i64() {
        return Some(if value.abs() < 10_000_000_000 {
            value.saturating_mul(1000)
        } else {
            value
        });
    }
    timestamp.as_str().and_then(|text| {
        chrono::DateTime::parse_from_rfc3339(text)
            .ok()
            .map(|date| date.timestamp_millis())
    })
}

struct PendingToolInput {
    id: String,
    name: String,
    json_buf: String,
}

/// [stream path] �?Claude Code 子进�?stdout 的一�?JSONL 解析�?/// `ParsedClaudeStdoutLine`。非 JSON 行作�?raw 文本 Text chunk 透传,
/// JSON 行转 AgentChunk 列表。�? `stream.rs::read_claude_stdout` 调用�?/// 流式回显。同会话�?history path �?`history.rs::value_to_chat_messages`,
/// 数据源是 `~/.claude/projects/.../sid.jsonl` ── 两条�?��处理的是同一�?/// 对话的不同�?�?streaming �?��时切�? history �?��缩后的全�?�?///
/// �?��口是�?partial 兜底(单元测试 / �?�� `--include-partial-messages` 的历�?/// �?��);真实流式�?���?[`parse_claude_stdout_line_with_state`](partial=true +
/// 璺ㄨ state)
#[allow(dead_code)] // �?partial 兜底 + 单元测试入口; 生产流式�?with_state�?
pub(crate) fn parse_claude_stdout_line(thread_id: &str, line: &str) -> ParsedClaudeStdoutLine {
    parse_claude_stdout_line_inner(thread_id, line, false, &mut ClaudeStreamState::default())
}

/// [stream path] partial 妯″紡涓撶敤鍏ュ彛 鈹€鈹€ `read_claude_stdout` 鎸佹湁璺ㄨ `state`,
/// `partial=true` 抑制冗余 `assistant` �?��(delta 已驱动渲�?, 并把
/// `stream_event` 解析成�?�?`AgentChunk`。`state` 在调用方�?��里跨行�?�?
/// 同一会话�?`input_json_delta` 分片在�?�?���?
pub(crate) fn parse_claude_stdout_line_with_state(
    thread_id: &str,
    line: &str,
    state: &mut ClaudeStreamState,
) -> ParsedClaudeStdoutLine {
    parse_claude_stdout_line_inner(thread_id, line, true, state)
}

fn parse_claude_stdout_line_inner(
    thread_id: &str,
    line: &str,
    partial: bool,
    state: &mut ClaudeStreamState,
) -> ParsedClaudeStdoutLine {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        if looks_like_claude_json_event_line(line) {
            return ParsedClaudeStdoutLine {
                value: None,
                session_id: None,
                chunks: Vec::new(),
            };
        }
        return ParsedClaudeStdoutLine {
            value: None,
            session_id: None,
            chunks: vec![AgentChunk::Text {
                thread_id: thread_id.to_string(),
                text: format!("{line}\n"),
            }],
        };
    };

    let session_id = extract_session_id(&value);
    let chunks = claude_event_to_chunks_with_state(thread_id, &value, partial, state);

    ParsedClaudeStdoutLine {
        value: Some(value),
        session_id,
        chunks,
    }
}

/// [history path primarily] Claude Code v2 �?Task �?agent 完成的通知
/// 包成 `type=user` 消息喂给�?agent,内�?�?���?/// `<task-notification>...</task-notification>` XML —�?这一形态只�?/// 持久�?JSONL 里出�?�?CLI 在压�?/ 上下文恢复阶段写�?�?/// 流式 stdout �?sub-agent 完成通知改走 `type=result, origin.kind=
/// "task-notification"`(�?type=user 形�?,所以本 helper �?stream path
/// 上实际上�?no-op�?///
/// `origin.kind == "task-notification"` �?���?���?schema 级信�?
/// 旧版�?��非标格式�?��没有 origin 字�?�?content 直接�?`<task-notification>`
/// 瀛楃涓测€斺€斾竴骞跺厹搴曘€?
fn is_synthetic_user_event(value: &Value) -> bool {
    if value.get("type").and_then(Value::as_str) != Some("user") {
        return false;
    }
    if value
        .get("origin")
        .and_then(|o| o.get("kind"))
        .and_then(Value::as_str)
        == Some("task-notification")
    {
        return true;
    }
    if let Some(content) = value.get("message").and_then(|m| m.get("content")) {
        if let Some(text) = content.as_str() {
            return text.trim_start().starts_with("<task-notification>");
        }
    }
    false
}

/// [both paths] 流式 `isSynthetic=true` + 持久�?`isMeta=true` 的统一
/// helper。两者�?义相�?标�?"harness / CLI 合成�?user 消息"(主�?�?/// Skill 工具调用时注入的 skill body,以及 `Your previous response had no
/// visible output...` 一类的隐式提醒),�?thread card 上不应展示�?///
/// 字�?名随载体不同,�?helper 同时覆盖两条�?��:
///   - [stream path]  娴佸紡 stdout(v2.1.207+): 椤跺眰 `isSynthetic` 瀛楁
///   - [history path] 持久�?JSONL: 顶层 `isMeta` 字�?(出现�?--resume /
///                     鍘嬬缉閲嶅缓闃舵,浠ュ強閮ㄥ垎琛屽悓鏃跺湪鎸佷箙鍖栨枃浠朵腑)
/// 两个都�?盖以�?resume / 压缩重建场景下混用�?致漏过�?
fn is_synthetic_user_marker(value: &Value) -> bool {
    if value.get("type").and_then(Value::as_str) != Some("user") {
        return false;
    }
    if value.get("isSynthetic").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    if value.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    if value
        .get("isVisibleInTranscriptOnly")
        .and_then(Value::as_bool)
        == Some(true)
    {
        return true;
    }
    if value.get("isCompactSummary").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    if message_content_text(value).is_some_and(|text| is_claude_skill_injection_text(&text)) {
        return true;
    }
    false
}

fn message_content_text(value: &Value) -> Option<String> {
    let content = value
        .get("message")
        .and_then(|m| m.get("content"))
        .or_else(|| value.get("content"))?;
    match content {
        Value::String(text) => Some(text.to_string()),
        Value::Array(parts) => {
            let text = parts
                .iter()
                .filter_map(|part| {
                    part.get("text")
                        .or_else(|| part.get("content"))
                        .and_then(Value::as_str)
                })
                .collect::<Vec<_>>()
                .join("");
            (!text.trim().is_empty()).then_some(text)
        }
        _ => None,
    }
}

fn is_claude_skill_injection_text(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with("Base directory for this skill:")
        || trimmed.starts_with("# Building LLM-Powered Applications with Claude")
        || trimmed.contains("\n# Building LLM-Powered Applications with Claude")
}

fn looks_like_claude_json_event_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with('{')
        && (trimmed.contains(r#""type":"user""#)
            || trimmed.contains(r#""type": "user""#)
            || trimmed.contains(r#""type":"assistant""#)
            || trimmed.contains(r#""type": "assistant""#)
            || trimmed.contains(r#""type":"stream_event""#)
            || trimmed.contains(r#""type": "stream_event""#)
            || trimmed.contains(r#""type":"result""#)
            || trimmed.contains(r#""type": "result""#)
            || trimmed.contains(r#""type":"system""#)
            || trimmed.contains(r#""type": "system""#)
            || trimmed.contains("Base directory for this skill:"))
}

/// [both paths] 统一静默判定入口 ── �?events.rs(stream) �?history.rs
/// (history) 两个入口都会�?��用。返�?`Some(reason)` 时�?事件应在渲染�?/// 整条丢弃;`reason` �?��定的字�?串标�?�?���?`tracing::debug!` 日志�?/// 单元测试�?��,绝不展示给最终用户�?///
/// 检查顺序固�?从最具体�?系统合成"信号到最�?同时反映两条 path �?/// 命中频率 ── 高�?信号在前,避免无谓的低频�?�?:
///   1. synthetic_user_event   [history]   task-notification(origin.kind �?<task-notification> 前缀)
///   2. synthetic_user_marker  [both]      Skill body 注入 / 系统提醒(isSynthetic �?isMeta)
/// 任何多重命中优先归到最先匹配的那一�?避免日志里同一行出现�?�?reason�?
pub(super) fn silence_reason(value: &Value) -> Option<&'static str> {
    if is_synthetic_user_event(value) {
        return Some("synthetic_user_event");
    }
    if is_synthetic_user_marker(value) {
        return Some("synthetic_user_marker");
    }
    None
}

/// [both paths] `silence_reason(value).is_some()` 鐨勮涔夌硸,鐢ㄤ簬"璇ヨ
/// �?��应丢�?的纯布尔判定(不需�?reason 字�?�?。`silence_reason` �?/// `should_silence_event` 都�?外暴�?前者用于需要打日志的入�?/// (events.rs::claude_event_to_chunks / history.rs::value_to_chat_messages),
/// 后者用�?反向条件"判断(history.rs::read_claude_session_meta 的标�?/// 候选条�?,少做一�?Option 解包�?
pub(super) fn should_silence_event(value: &Value) -> bool {
    silence_reason(value).is_some()
}

/// [stream path] 单�? JSONL �?AgentChunk 列表。�? `parse_claude_stdout_line`
/// 调用,�?���?stdout 解析的最底层。entry guard �?`silence_reason` 拦截
/// 合成消息(详�? `silence_reason` �?doc);通过后按 `type` 分发到各 block
/// 澶勭悊鍒嗘敮(assistant / user / result / system / 鏈煡 type fallback)
#[allow(dead_code)] // �?partial 兜底 + 单元测试入口; 生产流式�?with_state�?
pub(crate) fn claude_event_to_chunks(thread_id: &str, value: &Value) -> Vec<AgentChunk> {
    claude_event_to_chunks_with_state(thread_id, value, false, &mut ClaudeStreamState::default())
}

pub(crate) fn claude_event_to_chunks_with_state(
    thread_id: &str,
    value: &Value,
    partial: bool,
    state: &mut ClaudeStreamState,
) -> Vec<AgentChunk> {
    if let Some(reason) = silence_reason(value) {
        tracing::debug!(
            "[ClaudeCli] silenced event thread_id={thread_id} reason={reason} \
             event_type={} is_meta={} is_sidechain={} origin_kind={}",
            value
                .get("type")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default(),
            value
                .get("isMeta")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            value
                .get("isSidechain")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            value
                .get("origin")
                .and_then(|o| o.get("kind"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default(),
        );
        return Vec::new();
    }

    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();

    // [stream path, partial only] type=stream_event 鈹€鈹€ Anthropic 鍘熺敓娴佸紡浜嬩欢
    // (message_start / content_block_start|delta|stop / message_delta|stop)�?    // text_delta / thinking_delta -> 增量 Text / Reasoning;input_json_delta ->
    // 跨�?�?��;message_delta -> Usage。partial=false 时不会出现�? type�?
    if event_type == "stream_event" {
        return stream_event_to_chunks(thread_id, value, state);
    }

    // [stream path] type=assistant 分发 ── text / thinking / tool_use �?    // �?对应 AgentChunk;image / attachment �?�?静默丢弃�?
    if event_type == "assistant" {
        // partial: delta 已驱动渲�? 丢弃冗余�?���?��。partial �?��与非 partial
        // 完整消息�?stop_reason 都是 null, �?���?`partial` 标志区分�?
        if partial {
            // text/thinking 已由 stream_event delta 驱动渲染,跳过;但对内置工具
            // (WebSearch / Agent / TaskOutput 等无 stream_event 增量、仅存于快照的
            // 工具)补发 ToolCall,避免后续 tool_result 因 name="" 且无配对 tool_call
            // 渲染成 "Unknown Tool"。详见 reconcile_partial_assistant_tool_calls。
            return reconcile_partial_assistant_tool_calls(thread_id, value, state);
        }
        let mut chunks = Vec::new();
        if let Some(content) = value
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        {
            for block in content {
                match block
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                {
                    "text" => {
                        if let Some(text) = block.get("text").and_then(Value::as_str) {
                            if !text.trim().is_empty() {
                                chunks.push(AgentChunk::Text {
                                    thread_id: thread_id.to_string(),
                                    text: text.to_string(),
                                });
                            }
                        }
                    }
                    "thinking" => {
                        if let Some(text) = block
                            .get("thinking")
                            .or_else(|| block.get("text"))
                            .and_then(Value::as_str)
                        {
                            if !text.trim().is_empty() {
                                chunks.push(AgentChunk::Reasoning {
                                    thread_id: thread_id.to_string(),
                                    text: text.to_string(),
                                });
                            }
                        }
                    }
                    "tool_use" => {
                        let id = block
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("claude_tool")
                            .to_string();
                        let name = block
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("tool")
                            .to_string();
                        chunks.push(AgentChunk::ToolCall {
                            thread_id: thread_id.to_string(),
                            id,
                            name,
                            input: block.get("input").cloned().unwrap_or(Value::Null),
                        });
                    }
                    _ => {}
                }
            }
        }
        return chunks;
    }

    // [stream path] type=user 只分发 tool_result。真实用户文本由产品侧
    // optimistic message 持有，不能转成 AgentChunk::Text 后误标为 assistant。
    // image / attachment 等其余 block 静默
    // 丢弃。合成消�?isMeta / isSynthetic /
    // task-notification)�?entry guard `silence_reason` 在分发前拦截,
    // 涓嶄細鍒拌繖閲屻€?
    if event_type == "user" {
        let mut chunks = Vec::new();
        if let Some(content) = value
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        {
            for block in content {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {}
                    Some("tool_result") => {
                        let id = block
                            .get("tool_use_id")
                            .or_else(|| block.get("id"))
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("claude_tool")
                            .to_string();
                        chunks.push(AgentChunk::ToolResult {
                            thread_id: thread_id.to_string(),
                            id,
                            name: String::new(),
                            result: claude_tool_result_value(block),
                        });
                    }
                    _ => {}
                }
            }
        }
        return chunks;
    }

    // [stream path] type=result 鈹€鈹€ CLI 缁堟鏍囪,娓叉煋鍓嶄涪寮冦€?
    if event_type == "result" {
        return Vec::new();
    }

    // [stream path] type=system 鈹€鈹€ subtype=error 杞?AgentChunk::Error,
    // 其他 subtype(init / thinking_tokens �?�?harness 元数�?丢弃�?
    if event_type == "system" {
        if value.get("subtype").and_then(Value::as_str) == Some("error") {
            if let Some(text) = first_string(value, &["message", "error"]) {
                return vec![AgentChunk::Error {
                    thread_id: thread_id.to_string(),
                    message: text,
                }];
            }
        }
        return Vec::new();
    }

    // [stream path] �?�� type 兜底 ── �?first_string 找顶�?string 字�?�?
    if let Some(text) = first_string(value, &["delta", "text", "content"]) {
        if !text.trim().is_empty() {
            return vec![AgentChunk::Text {
                thread_id: thread_id.to_string(),
                text,
            }];
        }
    }

    Vec::new()
}

/// [stream path, partial only] 解析 `type=stream_event` 行。`event` �?Anthropic
/// 原生流式事件, `index` 标识 content_block。tool_use �?`input` 通过
/// `input_json_delta` 分片�?���?`state`, �?`content_block_stop` flush �?/// `AgentChunk::ToolCall`(解析失败 / �?-> `{}`)�?///
/// sub-agent �?stream_event �?`parent_tool_use_id`(�?null)── 与非 partial
/// �?��一�? sub-agent 活动按�?计展示在�?thread card �?�?cli.rs
/// `emits_claude_subagent_event_while_streaming`), 姝ゅ涓嶉澶栬繃婊ゃ€?
fn stream_event_to_chunks(
    thread_id: &str,
    value: &Value,
    state: &mut ClaudeStreamState,
) -> Vec<AgentChunk> {
    let Some(ev) = value.get("event") else {
        return Vec::new();
    };
    let event_type = ev.get("type").and_then(Value::as_str).unwrap_or_default();
    let index = ev.get("index").and_then(Value::as_i64).unwrap_or(0);

    match event_type {
        // �?message 开�? 清掉上一�?��留的 pending tool input, 防跨�?��漏�?
        "message_start" => {
            state.pending_tool_inputs.clear();
            state.current_message_id = ev
                .pointer("/message/id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .map(str::to_string);
            Vec::new()
        }
        // tool_use 块开�? �?id / name, input �?input_json_delta �?���?
        // text / thinking �?start �?chunk(内�?�?delta 投�?�?
        "content_block_start" => {
            let is_tool_use = ev
                .get("content_block")
                .and_then(|b| b.get("type"))
                .and_then(Value::as_str)
                == Some("tool_use");
            if is_tool_use {
                let cb = ev.get("content_block").cloned().unwrap_or(Value::Null);
                let id = cb
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("claude_tool")
                    .to_string();
                let name = cb
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_string();
                state.pending_tool_inputs.insert(
                    index,
                    PendingToolInput {
                        id,
                        name,
                        json_buf: String::new(),
                    },
                );
            }
            Vec::new()
        }
        "content_block_delta" => {
            let delta = ev.get("delta").cloned().unwrap_or(Value::Null);
            match delta
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
            {
                "text_delta" => match delta.get("text").and_then(Value::as_str) {
                    Some(text) if !text.is_empty() => vec![AgentChunk::Text {
                        thread_id: thread_id.to_string(),
                        text: text.to_string(),
                    }],
                    _ => Vec::new(),
                },
                "thinking_delta" => match delta.get("thinking").and_then(Value::as_str) {
                    Some(text) if !text.is_empty() => vec![AgentChunk::Reasoning {
                        thread_id: thread_id.to_string(),
                        text: text.to_string(),
                    }],
                    _ => Vec::new(),
                },
                "input_json_delta" => {
                    if let Some(fragment) = delta.get("partial_json").and_then(Value::as_str) {
                        if let Some(pending) = state.pending_tool_inputs.get_mut(&index) {
                            pending.json_buf.push_str(fragment);
                        }
                    }
                    Vec::new()
                }
                _ => Vec::new(),
            }
        }
        // flush �?���?tool_use input -> ToolCall(解析失败 / �?-> `{}`)�?
        "content_block_stop" => match state.pending_tool_inputs.remove(&index) {
            Some(pending) => {
                // 若该 id 已被完整快照补发过(insert 返回 false),跳过避免重复 ToolCall。
                if !state.emitted_tool_call_ids.insert(pending.id.clone()) {
                    return Vec::new();
                }
                let input = if pending.json_buf.trim().is_empty() {
                    serde_json::json!({})
                } else {
                    serde_json::from_str(&pending.json_buf)
                        .unwrap_or_else(|_| serde_json::json!({}))
                };
                vec![AgentChunk::ToolCall {
                    thread_id: thread_id.to_string(),
                    id: pending.id,
                    name: pending.name,
                    input,
                }]
            }
            None => Vec::new(),
        },
        // �?�� usage(input / output / cache_read tokens)。stop_reason 也在�?���?
        // 但前�?�� stream_end 收敛 run, 无需额�? chunk�?
        "message_delta" => match ev.get("usage") {
            Some(usage) => vec![AgentChunk::Usage {
                thread_id: thread_id.to_string(),
                model_id: None,
                last_run_at: None,
                usage: Some(UsageInfo {
                    input_tokens: usage
                        .get("input_tokens")
                        .and_then(Value::as_u64)
                        .map(|v| v as u32),
                    cached_input_tokens: usage
                        .get("cache_read_input_tokens")
                        .and_then(Value::as_u64)
                        .map(|v| v as u32),
                    output_tokens: usage
                        .get("output_tokens")
                        .and_then(Value::as_u64)
                        .map(|v| v as u32),
                    reasoning_output_tokens: None,
                    total_tokens: None,
                    model_context_window: None,
                }),
                status_info: None,
            }],
            None => Vec::new(),
        },
        "message_stop" => {
            state.current_message_id = None;
            Vec::new()
        }
        // 其他: �?chunk�?
        _ => Vec::new(),
    }
}

// [both paths] ToolResult payload 序列�?── events.rs �?history.rs �?// 两条 path 在推 ToolResult 时都会调这里�?block.content �?��统一 envelope�?
/// [stream path, partial only] 完整 `type=assistant` 快照里的 tool_use 补发。
///
/// `--include-partial-messages` 下 Claude Code 对普通模型工具(Bash / Read 等)会先
/// 发 `stream_event` content_block_* 增量再发完整快照;但对内置工具(WebSearch 服务
/// 端工具、Agent / Task / TaskOutput 等 SDK 编排工具)只产出完整 `type=assistant`
/// 快照,没有 stream_event 增量。partial 主路径会整条丢弃快照(text/thinking 已由
/// delta 渲染),导致这些 tool_use 的 ToolCall 永不发出,后续 tool_result(name 恒
/// 为空)渲染成 "Unknown Tool"。
///
/// 本函数遍历快照 content,对**未在 `emitted_tool_call_ids` 登记**的 tool_use 补发
/// `AgentChunk::ToolCall`(含完整 input);text/thinking 跳过(已由 delta 流过)。
/// 同一 id 若已被 stream_event 发过则跳过,避免重复。
fn reconcile_partial_assistant_tool_calls(
    thread_id: &str,
    value: &Value,
    state: &mut ClaudeStreamState,
) -> Vec<AgentChunk> {
    let Some(content) = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let mut chunks = Vec::new();
    for block in content {
        if block.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        let id = block
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("claude_tool")
            .to_string();
        // insert 返回 false = 已由 stream_event 增量发过,跳过避免重复
        if !state.emitted_tool_call_ids.insert(id.clone()) {
            continue;
        }
        let name = block
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string();
        let input = block.get("input").cloned().unwrap_or(Value::Null);
        chunks.push(AgentChunk::ToolCall {
            thread_id: thread_id.to_string(),
            id,
            name,
            input,
        });
    }
    chunks
}

fn claude_tool_result_value(block: &Value) -> Value {
    let Some(content) = block.get("content") else {
        return super::claude_tool_result_envelope(block.clone(), block);
    };
    let content = match content {
        Value::String(text) => serde_json::json!({ "content": text }),
        Value::Array(parts) => {
            let text = parts
                .iter()
                .filter_map(|part| {
                    part.get("text")
                        .or_else(|| part.get("content"))
                        .and_then(Value::as_str)
                })
                .collect::<Vec<_>>()
                .join("");
            if text.trim().is_empty() {
                serde_json::json!({ "content": content })
            } else {
                serde_json::json!({ "content": text })
            }
        }
        _ => serde_json::json!({ "content": content }),
    };
    super::claude_tool_result_envelope(content, block)
}

// [stream path] 从顶�?/ 嵌�? message envelope 里递归�?session id ──
// Claude Code �?stdout JSONL 在顶层或 message.* 里都会带 session_id�?// 用于 `parse_claude_stdout_line` �?`SessionResolved` chunk 推送与
// `upsert_external_session` 鎸佷箙鍖栥€?
fn extract_session_id(value: &Value) -> Option<String> {
    for key in ["session_id", "sessionId", "uuid"] {
        if let Some(id) = value.get(key).and_then(Value::as_str) {
            return Some(id.to_string());
        }
    }
    value.get("message").and_then(extract_session_id)
}

// [stream path] 鏈煡 type 鍏滃簳鐢ㄧ殑閫掑綊 string 鏌ユ壘 鈹€鈹€ 鍏堢湅椤跺眰 keys,
// 鍐嶉€掑綊 Value::Object / Value::Array,鎵惧埌浠绘剰 string 瀛楁鍗宠繑鍥炪€?
fn first_string(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(Value::as_str) {
            return Some(text.to_string());
        }
    }

    match value {
        Value::Object(map) => map.values().find_map(|v| first_string(v, keys)),
        Value::Array(items) => items.iter().find_map(|v| first_string(v, keys)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streaming_metadata_uses_claude_message_and_tool_ids() {
        let mut state = ClaudeStreamState::default();
        let message_start = serde_json::json!({
            "type": "stream_event",
            "timestamp": "2026-07-30T01:02:03.456Z",
            "event": {
                "type": "message_start",
                "message": { "id": "msg_claude_1" }
            }
        });
        assert!(
            claude_event_to_chunks_with_state("thread_1", &message_start, true, &mut state,)
                .is_empty()
        );

        let text_delta = serde_json::json!({
            "type": "stream_event",
            "uuid": "d9193ae4-86b5-47a6-9e85-1bb4ef0acc1c",
            "event": {
                "type": "content_block_delta",
                "index": 2,
                "delta": { "type": "text_delta", "text": "hello" }
            }
        });
        let chunks = claude_event_to_chunks_with_state("thread_1", &text_delta, true, &mut state);
        let text_metadata = claude_chunk_metadata(&text_delta, &chunks[0], &state);
        assert_eq!(
            text_metadata.message_id.as_deref(),
            Some("assistant-msg_claude_1-block-2")
        );
        assert_eq!(text_metadata.content_mode, Some("delta"));

        let next_text_delta = serde_json::json!({
            "type": "stream_event",
            "uuid": "63038373-bb9a-446d-a640-6ea503e68857",
            "event": {
                "type": "content_block_delta",
                "index": 2,
                "delta": { "type": "text_delta", "text": " world" }
            }
        });
        let next_chunks =
            claude_event_to_chunks_with_state("thread_1", &next_text_delta, true, &mut state);
        let next_metadata = claude_chunk_metadata(&next_text_delta, &next_chunks[0], &state);
        assert_eq!(next_metadata.message_id, text_metadata.message_id);

        let call = AgentChunk::ToolCall {
            thread_id: "thread_1".to_string(),
            id: "toolu_1".to_string(),
            name: "Read".to_string(),
            input: serde_json::json!({}),
        };
        let result = AgentChunk::ToolResult {
            thread_id: "thread_1".to_string(),
            id: "toolu_1".to_string(),
            name: "Read".to_string(),
            result: serde_json::json!({ "content": "done" }),
        };
        let call_metadata = claude_chunk_metadata(&serde_json::json!({}), &call, &state);
        let result_metadata = claude_chunk_metadata(&serde_json::json!({}), &result, &state);
        assert_eq!(call_metadata.message_id, result_metadata.message_id);
        assert_eq!(call_metadata.message_id.as_deref(), Some("tool-toolu_1"));
        assert_eq!(call_metadata.message_phase, Some("started"));
        assert_eq!(result_metadata.message_phase, Some("completed"));

        assert_eq!(
            claude_event_timestamp_millis(&message_start),
            Some(1_785_373_323_456)
        );
    }

    #[test]
    fn maps_claude_stdout_contract_fixture_to_expected_chunks() {
        let mut state = ClaudeStreamState::default();
        let mut session_ids = Vec::new();
        let mut chunks = Vec::new();

        for line in include_str!("../fixtures/claude_stdout_contract.jsonl")
            .lines()
            .filter(|line| !line.trim().is_empty())
        {
            let parsed = parse_claude_stdout_line_with_state("thread_contract", line, &mut state);
            if let Some(session_id) = parsed.session_id {
                session_ids.push(session_id);
            }
            chunks.extend(parsed.chunks);
        }

        assert_eq!(session_ids, vec!["claude-session-1"]);
        assert_eq!(chunks.len(), 6);
        assert!(matches!(
            &chunks[0],
            AgentChunk::Reasoning { text, .. } if text == "Need inspect workspace."
        ));
        assert!(matches!(
            &chunks[1],
            AgentChunk::Text { text, .. } if text == "The workspace is "
        ));
        assert!(matches!(
            &chunks[2],
            AgentChunk::ToolCall { id, name, input, .. }
                if id == "toolu_1"
                    && name == "Bash"
                    && input.get("command").and_then(Value::as_str) == Some("pwd")
        ));
        assert!(matches!(
            &chunks[3],
            AgentChunk::Usage {
                usage: Some(crate::agent_types::UsageInfo {
                    input_tokens: Some(90),
                    cached_input_tokens: Some(30),
                    output_tokens: Some(12),
                    ..
                }),
                ..
            }
        ));
        assert!(matches!(
            &chunks[4],
            AgentChunk::ToolResult { id, result, .. }
                if id == "toolu_1"
                    && result.get("content").and_then(Value::as_str) == Some("/tmp/flowix\n")
        ));
        assert!(matches!(
            &chunks[5],
            AgentChunk::Error { message, .. } if message == "Claude transport error"
        ));
    }
}
