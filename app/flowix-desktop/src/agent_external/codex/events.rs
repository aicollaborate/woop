use serde_json::Value;

use crate::agent_external::AgentChunkMetadata;
use crate::agent_flowix::{AgentChunk, StatusInfo, UsageInfo};

use super::tool_events::{
    looks_like_unknown_tool_event, tool_event_definition, tool_event_id, tool_event_name,
    CodexToolEventDefinition, CodexToolEventMode,
};
use super::MAX_UI_OUTPUT_PREVIEW_CHARS;
use crate::agent_external::truncate_chars;

// Codex stdout event policy.
//
// Events converted into AgentChunk:
// - Official JSONL schema:
//   - item.started + item.type=command_execution -> ToolCall
//   - item.completed + lifecycle tool item -> ToolCall update + ToolResult
//   - item.completed + item.type=agent_message/message -> Text
//   - item.started/item.updated/item.completed + item.type=reasoning -> Reasoning
//   - item.started/item.completed + item.type=function_call/custom_tool_call -> ToolCall
//   - item.started/item.completed + item.type=function_call_output/custom_tool_call_output -> ToolResult
//   - turn.completed.usage -> Usage
//   - turn.failed/error -> Error, except transient reconnect/progress events
// - Legacy/internal schema:
//   - event_msg:agent_message -> Text
//   - event_msg:token_count -> Usage
//   - turn_context -> Usage metadata snapshot (model/context window only)
//   - response_item:reasoning/function_call/custom_tool_call/function_call_output/custom_tool_call_output
//     -> Reasoning/ToolCall/ToolResult
//
// Events intentionally ignored here:
// - thread.started: handled in codex_cli.rs as SessionResolved, not as a UI chunk.
// - turn.started/session_meta/compacted: lifecycle markers with no visible UI payload.
// - event_msg:task_started/task_complete/user_message/patch_apply_end/context_compacted:
//   lifecycle/noise; task_complete is handled in codex_cli.rs for stream_end.
// - response_item:message: skipped to avoid duplicate assistant text when event_msg:agent_message
//   carries the same output in older Codex streams.
#[derive(Debug)]
enum CodexEvent {
    /// Metadata-only event emitted into run state.
    Lifecycle {
        usage: Option<UsageSnapshot>,
    },
    Reasoning {
        text: String,
    },
    Text {
        text: String,
    },
    ToolCall {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        id: String,
        name: String,
        result: Value,
    },
    ToolComplete {
        id: String,
        name: String,
        input: Value,
        result: Value,
    },
    Error {
        message: String,
    },
    Unknown,
}

/// Token usage snapshot emitted by Codex `event_msg:token_count`.
/// Internal representation that aggregates `event_msg:token_count`,
/// `turn.completed.usage`, and `turn_context` payload 鈥?used to build the
/// wire-format [`UsageInfo`] + [`StatusInfo`] + top-level metadata chunks.
///
/// `prompt_tokens` / `completion_tokens` are kept here as parse-time helpers
/// but never reach the wire: they are folded into `input_tokens` /
/// `output_tokens` at construction time (Codex already reports new-protocol
/// fields, so the fold is a no-op in practice; the fields stay for parity
/// with the parse helpers and to absorb legacy/internal Codex payloads).
#[derive(Debug, Clone)]
struct UsageSnapshot {
    input_tokens: Option<u32>,
    cached_input_tokens: Option<u32>,
    output_tokens: Option<u32>,
    reasoning_output_tokens: Option<u32>,
    model_context_window: Option<u32>,
    model_id: Option<String>,
    codex_plan_type: Option<String>,
    codex_used_percent: Option<f64>,
    codex_resets_at: Option<i64>,
    last_run_at: Option<i64>,
    total_tokens: u32,
}

pub fn codex_event_to_chunks(thread_id: &str, value: &Value) -> Vec<AgentChunk> {
    match parse_codex_event(value) {
        CodexEvent::Lifecycle { usage: None } | CodexEvent::Unknown => Vec::new(),
        CodexEvent::Lifecycle { usage: Some(usage) } => {
            // 通用 metadata 协�? ── 透传给前�? �?���?run / thread�?
            // token 字�?走嵌�?`UsageInfo`,codex plan 信息走嵌�?`StatusInfo`,
            // model_id / last_run_at 留在顶层�?
            vec![AgentChunk::Usage {
                thread_id: thread_id.to_string(),
                model_id: usage.model_id,
                last_run_at: usage.last_run_at,
                usage: Some(UsageInfo {
                    input_tokens: usage.input_tokens,
                    cached_input_tokens: usage.cached_input_tokens,
                    output_tokens: usage.output_tokens,
                    reasoning_output_tokens: usage.reasoning_output_tokens,
                    total_tokens: Some(usage.total_tokens),
                    model_context_window: usage.model_context_window,
                }),
                status_info: Some(StatusInfo {
                    codex_plan_type: usage.codex_plan_type,
                    codex_used_percent: usage.codex_used_percent,
                    codex_resets_at: usage.codex_resets_at,
                }),
            }]
        }
        CodexEvent::Reasoning { text } => vec![AgentChunk::Reasoning {
            thread_id: thread_id.to_string(),
            text,
        }],
        CodexEvent::Text { text } => vec![AgentChunk::Text {
            thread_id: thread_id.to_string(),
            text,
        }],
        CodexEvent::ToolCall { id, name, input } => vec![AgentChunk::ToolCall {
            thread_id: thread_id.to_string(),
            id,
            name,
            input,
        }],
        CodexEvent::ToolResult { id, name, result } => vec![AgentChunk::ToolResult {
            thread_id: thread_id.to_string(),
            id,
            name,
            result,
        }],
        CodexEvent::ToolComplete {
            id,
            name,
            input,
            result,
        } => vec![
            AgentChunk::ToolCall {
                thread_id: thread_id.to_string(),
                id: id.clone(),
                name: name.clone(),
                input,
            },
            AgentChunk::ToolResult {
                thread_id: thread_id.to_string(),
                id,
                name,
                result,
            },
        ],
        CodexEvent::Error { message } => vec![AgentChunk::Error {
            thread_id: thread_id.to_string(),
            message,
        }],
    }
}

pub(crate) fn codex_chunk_metadata(value: &Value, chunk: &AgentChunk) -> AgentChunkMetadata {
    let event_type = value
        .get("type")
        .or_else(|| value.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let source_item_id = codex_source_item_id(value);

    match chunk {
        AgentChunk::Text { .. } => AgentChunkMetadata {
            message_id: source_item_id.map(|id| format!("assistant-{id}")),
            message_phase: Some(match event_type.as_str() {
                "item.started" => "started",
                "item.updated" => "updated",
                _ => "completed",
            }),
            content_mode: Some("snapshot"),
            ..Default::default()
        },
        AgentChunk::Reasoning { .. } => AgentChunkMetadata {
            message_id: source_item_id.map(|id| format!("reasoning-{id}")),
            message_phase: Some(match event_type.as_str() {
                "item.started" => "started",
                "item.updated" => "updated",
                _ => "completed",
            }),
            content_mode: Some("snapshot"),
            ..Default::default()
        },
        AgentChunk::ToolCall { id, .. } => AgentChunkMetadata {
            message_id: Some(format!("tool-{id}")),
            message_phase: Some(if event_type == "item.started" {
                "started"
            } else {
                "updated"
            }),
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

fn codex_source_item_id(value: &Value) -> Option<String> {
    let payload = value
        .get("item")
        .or_else(|| value.get("payload").and_then(|payload| payload.get("item")))
        .or_else(|| value.get("payload"))
        .unwrap_or(value);
    ["id", "call_id", "tool_call_id"]
        .into_iter()
        .find_map(|key| payload.get(key).and_then(Value::as_str))
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string)
}

fn parse_codex_event(value: &Value) -> CodexEvent {
    let event_type = value
        .get("type")
        .or_else(|| value.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();

    match event_type.as_str() {
        "event_msg" => parse_codex_event_msg(value),
        "error" => first_string(value, &["message", "error"])
            .filter(|message| !message.trim().is_empty())
            .filter(|message| !is_transient_codex_status_message(message))
            .map(|message| CodexEvent::Error { message })
            .unwrap_or(CodexEvent::Unknown),
        "turn.failed" => parse_turn_failed(value),
        "item.started" | "item.updated" | "item.completed" => {
            parse_codex_item_event(value, &event_type)
        }
        "turn_context" => {
            let payload = event_payload(value);
            CodexEvent::Lifecycle {
                usage: Some(UsageSnapshot {
                    input_tokens: None,
                    cached_input_tokens: None,
                    output_tokens: None,
                    reasoning_output_tokens: None,
                    model_context_window: number_u32(
                        payload,
                        &["model_context_window", "context_window"],
                    ),
                    model_id: first_string(payload, &["model_id", "modelId", "model"]),
                    codex_plan_type: None,
                    codex_used_percent: None,
                    codex_resets_at: None,
                    last_run_at: parse_event_timestamp_millis(value),
                    total_tokens: 0,
                }),
            }
        }
        "response_item" => parse_codex_response_item(value),
        "turn.completed" => value
            .get("usage")
            .map(|usage| CodexEvent::Lifecycle {
                usage: Some(usage_from_token_count(value, usage)),
            })
            .unwrap_or(CodexEvent::Unknown),
        "thread.started" | "turn.started" | "session_meta" | "compacted" => CodexEvent::Unknown,
        _ => CodexEvent::Unknown,
    }
}

fn parse_codex_event_msg(value: &Value) -> CodexEvent {
    let payload = event_payload(value);
    let payload_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();

    match payload_type.as_str() {
        "token_count" => CodexEvent::Lifecycle {
            usage: Some(usage_from_token_count(value, payload)),
        },
        "agent_message" => first_string(payload, &["message", "text", "content"])
            .filter(|text| !text.trim().is_empty())
            .map(|text| CodexEvent::Text { text })
            .unwrap_or(CodexEvent::Unknown),
        "task_started" | "task_complete" | "user_message" | "context_compacted" => {
            CodexEvent::Unknown
        }
        _ => {
            if let Some(definition) = tool_event_definition(&payload_type) {
                tool_complete_from_payload(payload, &payload_type, Some(definition))
            } else if looks_like_unknown_tool_event(&payload_type, payload) {
                tool_complete_from_payload(payload, &payload_type, None)
            } else {
                CodexEvent::Unknown
            }
        }
    }
}

fn parse_codex_response_item(value: &Value) -> CodexEvent {
    let payload = value
        .get("payload")
        .or_else(|| value.get("item"))
        .unwrap_or(value);
    let item_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();

    let non_tool_event = match item_type.as_str() {
        "reasoning" => first_string(payload, &["summary", "text", "content", "message"])
            .filter(|text| !text.trim().is_empty())
            .map(|text| CodexEvent::Reasoning { text })
            .unwrap_or(CodexEvent::Unknown),
        "message" => CodexEvent::Unknown,
        _ => {
            if let Some(definition) = tool_event_definition(&item_type) {
                return tool_event_from_response_item(payload, &item_type, definition);
            }
            if looks_like_unknown_tool_event(&item_type, payload) {
                return tool_complete_from_payload(payload, &item_type, None);
            }
            CodexEvent::Unknown
        }
    };
    non_tool_event
}

fn tool_event_from_response_item(
    payload: &Value,
    item_type: &str,
    definition: CodexToolEventDefinition,
) -> CodexEvent {
    match definition.mode {
        CodexToolEventMode::Call => tool_call_from_response_item(payload, item_type),
        CodexToolEventMode::Result => tool_result_from_response_item(payload, item_type),
        CodexToolEventMode::Lifecycle | CodexToolEventMode::Complete => {
            tool_complete_from_payload(payload, item_type, Some(definition))
        }
    }
}

fn parse_codex_item_event(value: &Value, event_type: &str) -> CodexEvent {
    let payload = value
        .get("item")
        .or_else(|| value.get("payload").and_then(|payload| payload.get("item")))
        .or_else(|| value.get("payload"))
        .unwrap_or(value);
    let item_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();

    let non_tool_event = match item_type.as_str() {
        "agent_message" | "message" => message_text(payload)
            .filter(|text| !text.trim().is_empty())
            .map(|text| CodexEvent::Text { text })
            .unwrap_or(CodexEvent::Unknown),
        "reasoning" => first_string(payload, &["summary", "text", "content", "message"])
            .filter(|text| !text.trim().is_empty())
            .map(|text| CodexEvent::Reasoning { text })
            .unwrap_or(CodexEvent::Unknown),
        _ => {
            if let Some(definition) = tool_event_definition(&item_type) {
                return tool_event_from_item_envelope(
                    payload,
                    &item_type,
                    event_type,
                    Some(definition),
                );
            }
            if looks_like_unknown_tool_event(&item_type, payload) {
                return tool_event_from_item_envelope(payload, &item_type, event_type, None);
            }
            CodexEvent::Unknown
        }
    };
    non_tool_event
}

fn tool_event_from_item_envelope(
    payload: &Value,
    item_type: &str,
    event_type: &str,
    definition: Option<CodexToolEventDefinition>,
) -> CodexEvent {
    let mode = definition
        .map(|definition| definition.mode)
        .unwrap_or(CodexToolEventMode::Complete);
    match mode {
        CodexToolEventMode::Call => tool_call_from_response_item(payload, item_type),
        CodexToolEventMode::Result => tool_result_from_response_item(payload, item_type),
        CodexToolEventMode::Lifecycle if event_type == "item.started" => {
            tool_call_from_payload(payload, item_type, definition)
        }
        CodexToolEventMode::Lifecycle if event_type == "item.completed" => {
            tool_complete_from_payload(payload, item_type, definition)
        }
        CodexToolEventMode::Lifecycle => tool_call_from_payload(payload, item_type, definition),
        CodexToolEventMode::Complete if event_type == "item.started" => {
            tool_call_from_payload(payload, item_type, definition)
        }
        CodexToolEventMode::Complete => tool_complete_from_payload(payload, item_type, definition),
    }
}

fn parse_turn_failed(value: &Value) -> CodexEvent {
    let payload = event_payload(value);
    first_string(payload, &["message", "error"])
        .or_else(|| first_string(value, &["message", "error"]))
        .filter(|message| !message.trim().is_empty())
        .filter(|message| !is_transient_codex_status_message(message))
        .map(|message| CodexEvent::Error { message })
        .unwrap_or(CodexEvent::Unknown)
}

pub fn is_transient_codex_reconnect_event(value: &Value) -> bool {
    let event_type = value
        .get("type")
        .or_else(|| value.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(event_type.as_str(), "turn.failed" | "error" | "event_msg") {
        return false;
    }
    let payload = event_payload(value);
    first_string(payload, &["message", "error", "text", "content"])
        .or_else(|| first_string(value, &["message", "error", "text", "content"]))
        .as_deref()
        .map(is_transient_codex_status_message)
        .unwrap_or(false)
}

fn is_transient_codex_status_message(message: &str) -> bool {
    let normalized = message.trim().to_ascii_lowercase();
    normalized.contains("reconnecting")
        || normalized.contains("reconnect")
        || normalized.contains("retrying")
        || normalized.contains("temporarily unavailable")
}

fn message_text(payload: &Value) -> Option<String> {
    if let Some(role) = payload.get("role").and_then(Value::as_str) {
        if role != "assistant" {
            return None;
        }
    }

    if let Some(text) = payload
        .get("text")
        .or_else(|| payload.get("message"))
        .and_then(Value::as_str)
        .map(str::to_string)
    {
        return Some(text);
    }

    let content = payload.get("content")?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    if let Some(items) = content.as_array() {
        let parts: Vec<String> = items
            .iter()
            .filter_map(|item| first_string(item, &["text", "content"]))
            .filter(|text| !text.trim().is_empty())
            .collect();
        if !parts.is_empty() {
            return Some(parts.join(""));
        }
    }
    None
}

fn event_payload(value: &Value) -> &Value {
    value.get("payload").unwrap_or(value)
}

fn usage_from_token_count(value: &Value, payload: &Value) -> UsageSnapshot {
    let input = number_u32(payload, &["input_tokens", "input", "prompt_tokens"]);
    let output = number_u32(payload, &["output_tokens", "output", "completion_tokens"]);
    let reasoning_output = number_u32(
        payload,
        &["reasoning_output_tokens", "reasoning_tokens", "reasoning"],
    );
    let total = number_u32(payload, &["total_tokens", "total"])
        .or_else(|| checked_sum_u32(&[input, output, reasoning_output]))
        .unwrap_or(0);

    UsageSnapshot {
        input_tokens: input,
        cached_input_tokens: number_u32(payload, &["cached_input_tokens", "cached_tokens"]),
        output_tokens: output,
        reasoning_output_tokens: reasoning_output,
        model_context_window: number_u32(payload, &["model_context_window", "context_window"]),
        model_id: first_string(payload, &["model_id", "modelId", "model"]),
        codex_plan_type: first_string(payload, &["codex_plan_type", "plan_type", "plan"]),
        codex_used_percent: number_f64(
            payload,
            &["codex_used_percent", "used_percent", "usage_percent"],
        ),
        codex_resets_at: number_i64(payload, &["codex_resets_at", "resets_at", "reset_at"]),
        last_run_at: parse_event_timestamp_millis(value),
        total_tokens: total,
    }
}

fn tool_call_from_response_item(payload: &Value, item_type: &str) -> CodexEvent {
    tool_call_from_payload(payload, item_type, tool_event_definition(item_type))
}

fn tool_result_from_response_item(payload: &Value, item_type: &str) -> CodexEvent {
    tool_result_from_payload(payload, item_type, tool_event_definition(item_type))
}

fn tool_call_from_payload(
    payload: &Value,
    item_type: &str,
    definition: Option<CodexToolEventDefinition>,
) -> CodexEvent {
    let id = tool_event_id(payload, item_type);
    let name = tool_event_name(payload, definition, item_type);
    let input = tool_input_payload(payload, item_type);

    CodexEvent::ToolCall { id, name, input }
}

fn tool_result_from_payload(
    payload: &Value,
    item_type: &str,
    definition: Option<CodexToolEventDefinition>,
) -> CodexEvent {
    let id = tool_event_id(payload, item_type);
    let name = tool_event_name(payload, definition, item_type);
    let result = tool_result_payload(tool_output_payload(payload, item_type));

    CodexEvent::ToolResult { id, name, result }
}

fn tool_complete_from_payload(
    payload: &Value,
    item_type: &str,
    definition: Option<CodexToolEventDefinition>,
) -> CodexEvent {
    CodexEvent::ToolComplete {
        id: tool_event_id(payload, item_type),
        name: tool_event_name(payload, definition, item_type),
        input: tool_input_payload(payload, item_type),
        result: tool_result_payload(tool_output_payload(payload, item_type)),
    }
}

fn tool_input_payload(payload: &Value, item_type: &str) -> Value {
    if item_type == "todo_list" {
        return normalize_todo_list_input(payload);
    }
    if matches!(
        item_type,
        "mcp_tool_call" | "mcp_tool_call_end" | "dynamic_tool_call"
    ) {
        let invocation = payload.get("invocation");
        let tool = payload
            .get("tool")
            .or_else(|| payload.get("tool_name"))
            .or_else(|| payload.get("name"))
            .or_else(|| invocation.and_then(|value| value.get("tool")))
            .cloned()
            .unwrap_or(Value::Null);
        let server = payload
            .get("server")
            .or_else(|| invocation.and_then(|value| value.get("server")))
            .cloned()
            .unwrap_or(Value::Null);
        let arguments = payload
            .get("arguments")
            .or_else(|| payload.get("input"))
            .or_else(|| invocation.and_then(|value| value.get("arguments")))
            .map(normalize_json_value)
            .unwrap_or(Value::Null);
        return serde_json::json!({
            "tool": tool,
            "server": server,
            "arguments": arguments,
        });
    }
    if matches!(item_type, "file_change" | "patch_apply_end") {
        return serde_json::json!({
            "changes": payload.get("changes").cloned().unwrap_or(Value::Null)
        });
    }
    if let Some(command) = payload.get("command") {
        return serde_json::json!({ "command": command });
    }
    let input_keys = [
        "arguments",
        "input",
        "params",
        "action",
        "query",
        "prompt",
        "changes",
    ];
    let present_inputs = input_keys
        .iter()
        .filter_map(|key| {
            payload
                .get(*key)
                .filter(|value| !value.is_null())
                .map(|value| ((*key).to_string(), normalize_json_value(value)))
        })
        .collect::<serde_json::Map<String, Value>>();
    if present_inputs.len() > 1 {
        return Value::Object(present_inputs);
    }
    if let Some((_, value)) = present_inputs.into_iter().next() {
        return value;
    }
    fallback_tool_payload(payload, item_type)
}

fn normalize_todo_list_input(payload: &Value) -> Value {
    let items = ["items", "todos", "plan"]
        .iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_array));
    let Some(items) = items else {
        return fallback_tool_payload(payload, "todo_list");
    };

    let plan = items
        .iter()
        .filter_map(|item| {
            if let Some(step) = item.as_str().filter(|step| !step.trim().is_empty()) {
                return Some(serde_json::json!({
                    "step": step.trim(),
                    "status": "pending",
                }));
            }
            let item = item.as_object()?;
            let step = ["step", "text", "content", "title", "label"]
                .iter()
                .find_map(|key| item.get(*key).and_then(Value::as_str))
                .map(str::trim)
                .filter(|step| !step.is_empty())?;
            let status = ["status", "state"]
                .iter()
                .find_map(|key| item.get(*key).and_then(Value::as_str))
                .map(normalize_todo_status)
                .or_else(|| {
                    item.get("completed")
                        .and_then(Value::as_bool)
                        .map(|completed| if completed { "completed" } else { "pending" })
                })
                .unwrap_or("pending");
            Some(serde_json::json!({
                "step": step,
                "status": status,
            }))
        })
        .collect::<Vec<_>>();

    serde_json::json!({ "plan": plan })
}

fn normalize_todo_status(status: &str) -> &'static str {
    match status.trim().to_ascii_lowercase().as_str() {
        "completed" | "complete" | "done" | "finished" | "success" | "succeeded" => "completed",
        "in_progress" | "in-progress" | "inprogress" | "doing" | "running" | "active"
        | "executing" => "in_progress",
        _ => "pending",
    }
}

fn tool_output_payload(payload: &Value, item_type: &str) -> Value {
    for key in [
        "output",
        "aggregated_output",
        "result",
        "content",
        "changes",
    ] {
        if let Some(value) = payload.get(key) {
            return normalize_json_value(value);
        }
    }
    fallback_tool_payload(payload, item_type)
}

fn fallback_tool_payload(payload: &Value, item_type: &str) -> Value {
    let raw = payload.to_string();
    let raw_chars = raw.chars().count();
    serde_json::json!({
        "codex_item_type": item_type,
        "raw_payload_chars": raw_chars,
        "raw_payload_truncated": raw_chars > MAX_UI_OUTPUT_PREVIEW_CHARS,
        "raw_payload_preview": truncate_chars(&raw, MAX_UI_OUTPUT_PREVIEW_CHARS),
    })
}

fn tool_result_payload(value: Value) -> Value {
    let text_output = match &value {
        Value::String(output) => Some(output.clone()),
        Value::Array(items) => {
            let parts = items
                .iter()
                .filter_map(|item| {
                    item.get("text")
                        .or_else(|| item.get("content"))
                        .and_then(Value::as_str)
                })
                .collect::<Vec<_>>();
            (!parts.is_empty()).then(|| parts.join(""))
        }
        _ => None,
    };
    if let Some(output) = text_output {
        let output_chars = output.chars().count();
        let output_truncated = output_chars > MAX_UI_OUTPUT_PREVIEW_CHARS;
        return serde_json::json!({
            "output_chars": output_chars,
            "output_truncated": output_truncated,
            "output_preview": truncate_chars(&output, MAX_UI_OUTPUT_PREVIEW_CHARS),
        });
    }
    value
}

fn normalize_json_value(value: &Value) -> Value {
    value
        .as_str()
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .unwrap_or_else(|| value.clone())
}

fn number_u32(value: &Value, keys: &[&str]) -> Option<u32> {
    for key in keys {
        if let Some(n) = value.get(*key).and_then(Value::as_u64) {
            if let Ok(n) = u32::try_from(n) {
                return Some(n);
            }
        }
        if let Some(n) = value
            .get(*key)
            .and_then(Value::as_i64)
            .and_then(|n| u32::try_from(n).ok())
        {
            return Some(n);
        }
    }
    None
}

fn number_i64(value: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_i64))
}

fn number_f64(value: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_f64))
}

fn checked_sum_u32(values: &[Option<u32>]) -> Option<u32> {
    let mut total = 0u32;
    let mut has_value = false;
    for value in values.iter().flatten() {
        has_value = true;
        total = total.checked_add(*value)?;
    }
    has_value.then_some(total)
}

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

pub(crate) fn parse_event_timestamp_millis(value: &Value) -> Option<i64> {
    let timestamp = value.get("timestamp").or_else(|| {
        value
            .get("payload")
            .and_then(|payload| payload.get("timestamp"))
    })?;
    if let Some(text) = timestamp.as_str() {
        return chrono::DateTime::parse_from_rfc3339(text)
            .map(|dt| dt.timestamp_millis())
            .ok();
    }
    if let Some(n) = timestamp.as_i64() {
        return Some(if n < 10_000_000_000 {
            n.saturating_mul(1000)
        } else {
            n
        });
    }
    if let Some(n) = timestamp.as_f64() {
        let millis = if n < 10_000_000_000.0 { n * 1000.0 } else { n };
        return Some(millis as i64);
    }
    None
}

#[cfg(test)]
mod tests;
