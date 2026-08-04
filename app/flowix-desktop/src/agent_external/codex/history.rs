use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use crate::agent_session::{ChatMessage, ThreadInfo, ThreadMessagesPage};
use crate::agent_types::AgentId;

use super::tool_events::{
    looks_like_unknown_tool_event, tool_event_definition, tool_event_id, tool_event_name,
    CodexToolEventMode,
};

const AGENT_TYPE: &str = "codex";
const MAX_HISTORY_TOOL_OUTPUT_CHARS: usize = 4096;

#[derive(Clone, Debug)]
pub(crate) struct CodexRolloutEvent {
    pub value: Value,
    pub source_sequence: u64,
    pub source_timestamp: Option<i64>,
}

impl Deref for CodexRolloutEvent {
    type Target = Value;

    fn deref(&self) -> &Self::Target {
        &self.value
    }
}

#[allow(dead_code)]
pub async fn list_sessions() -> Result<Vec<ThreadInfo>, String> {
    tokio::task::spawn_blocking(list_codex_sessions)
        .await
        .map_err(|e| e.to_string())?
}

pub async fn get_session(session_id: &str) -> Result<Vec<ChatMessage>, String> {
    let session_id = session_id.to_string();
    tokio::task::spawn_blocking(move || {
        let mut messages = read_codex_session_messages(&session_id)?;
        crate::agent_external::canonicalize_imported_messages(
            AGENT_TYPE,
            &session_id,
            &mut messages,
        );
        Ok(messages)
    })
        .await
        .map_err(|e| e.to_string())?
}

pub async fn get_session_page(
    session_id: &str,
    before_sequence: Option<i64>,
    limit: i64,
) -> Result<ThreadMessagesPage, String> {
    let session_id = session_id.to_string();
    tokio::task::spawn_blocking(move || {
        let mut messages = read_codex_session_messages(&session_id)?;
        crate::agent_external::canonicalize_imported_messages(
            AGENT_TYPE,
            &session_id,
            &mut messages,
        );
        Ok(paginate_codex_messages(messages, before_sequence, limit))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read tool-shaped `response_item` records written by Codex for the current
/// turn. The live stdout protocol omits some `custom_tool_call` wrappers, while
/// the rollout JSONL keeps them. This bounded slice is only used when stdout
/// ends without a normal `turn.completed`, never as normal-turn tail backfill.
pub(crate) async fn get_rollout_tool_response_items_since(
    session_id: &str,
    started_at_millis: i64,
) -> Result<Vec<CodexRolloutEvent>, String> {
    let session_id = session_id.to_string();
    tokio::task::spawn_blocking(move || {
        let Some(path) = find_codex_session_file(&session_id)? else {
            return Ok(Vec::new());
        };
        let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
        Ok(parse_rollout_tool_response_items_since(
            &text,
            started_at_millis,
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn parse_rollout_tool_response_items_since(
    text: &str,
    started_at_millis: i64,
) -> Vec<CodexRolloutEvent> {
    text.lines()
        .enumerate()
        .filter_map(|(index, line)| {
            serde_json::from_str::<Value>(line)
                .ok()
                .map(|value| (index, value))
        })
        .filter(|(_, value)| {
            value.get("type").and_then(Value::as_str) == Some("response_item")
                && value
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .and_then(parse_timestamp_millis)
                    .is_some_and(|timestamp| timestamp >= started_at_millis)
        })
        .filter(|(_, value)| {
            let payload = value.get("payload").unwrap_or(value);
            let item_type = payload
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            tool_event_definition(item_type).is_some()
                || looks_like_unknown_tool_event(item_type, payload)
        })
        .map(|(index, value)| CodexRolloutEvent {
            source_timestamp: value
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(parse_timestamp_millis),
            value,
            source_sequence: index as u64,
        })
        .collect()
}

pub fn is_codex_session_id(text: &str) -> bool {
    // 蹇呴』鏄惧紡鎷掔粷 "codex-local-agent-inst-<ts>-<seq>" 绛夊墠绔崰浣嶇 鈹€鈹€
    // 这些字�?串长�?�?32 且包�?5 �?dash, 老版宽松判断会把它当�?    // session id 传给 Codex CLI �?resume, �?CLI 不�? ── �?    // claude_history 同病同治�?
    let value = text.trim();
    if value.is_empty() || value.starts_with("codex-local-") {
        return false;
    }
    value.len() >= 32 && value.chars().filter(|c| *c == '-').count() == 4
}

#[allow(dead_code)]
#[derive(Default)]
struct CodexSessionDraft {
    id: String,
    title: Option<String>,
    created_at: Option<i64>,
    updated_at: Option<i64>,
    path: Option<PathBuf>,
}

#[allow(dead_code)]
fn list_codex_sessions() -> Result<Vec<ThreadInfo>, String> {
    let mut sessions: BTreeMap<String, CodexSessionDraft> = BTreeMap::new();

    for item in read_codex_history_items()? {
        let draft = sessions.entry(item.session_id.clone()).or_default();
        draft.id = item.session_id;
        draft.title = Some(item.text);
        draft.updated_at = Some(item.ts);
        draft.created_at = draft.created_at.or(Some(item.ts));
    }

    for path in codex_session_files()? {
        if let Ok(meta) = read_codex_session_meta(&path) {
            let draft = sessions.entry(meta.id.clone()).or_default();
            draft.id = meta.id;
            draft.path = Some(path);
            draft.created_at = draft.created_at.or(meta.created_at);
            draft.updated_at = draft.updated_at.max(meta.updated_at).or(meta.created_at);
            if draft
                .title
                .as_ref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true)
            {
                draft.title = meta.title;
            }
        }
    }

    let mut list = sessions
        .into_values()
        .filter(|draft| !draft.id.trim().is_empty())
        .map(|draft| {
            let created_at = draft
                .created_at
                .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
            ThreadInfo {
                thread_id: draft.id,
                agent_id: AgentId::new(AGENT_TYPE),
                title: draft
                    .title
                    .filter(|t| !t.trim().is_empty())
                    .unwrap_or_else(|| "Codex Session".to_string()),
                created_at,
                updated_at: draft.updated_at.unwrap_or(created_at),
            }
        })
        .collect::<Vec<_>>();
    list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(list)
}

fn read_codex_session_messages(session_id: &str) -> Result<Vec<ChatMessage>, String> {
    let path = find_codex_session_file(session_id)?
        .ok_or_else(|| format!("Codex session not found: {session_id}"))?;
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    Ok(parse_codex_session_messages(session_id, &text))
}

fn parse_codex_session_messages(session_id: &str, text: &str) -> Vec<ChatMessage> {
    let mut messages = Vec::new();
    let mut seen_user_messages = HashSet::new();
    let mut current_turn_id: Option<String> = None;
    let mut last_unkeyed_user: Option<(String, usize)> = None;

    for (idx, line) in text.lines().enumerate() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let timestamp = value
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let top_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let payload = value.get("payload").unwrap_or(&value);

        if top_type == "event_msg"
            && payload.get("type").and_then(Value::as_str) == Some("task_started")
        {
            current_turn_id = payload
                .get("turn_id")
                .and_then(Value::as_str)
                .map(str::to_string);
        }

        if top_type == "event_msg" {
            if let Some(message) = event_msg_to_chat_message(session_id, idx, &timestamp, payload) {
                if message.role == "user" {
                    if is_hidden_codex_user_message(&message.content) {
                        continue;
                    }
                    if !keep_codex_user_message(
                        payload,
                        current_turn_id.as_deref(),
                        &message.content,
                        idx,
                        &mut seen_user_messages,
                        &mut last_unkeyed_user,
                    ) {
                        continue;
                    }
                }
                messages.push(message);
            }
            continue;
        }

        if top_type != "response_item" {
            continue;
        }

        if let Some(message) = response_item_to_chat_message(session_id, idx, &timestamp, payload) {
            if message.role == "user" {
                if is_hidden_codex_user_message(&message.content) {
                    continue;
                }
                if !keep_codex_user_message(
                    payload,
                    current_turn_id.as_deref(),
                    &message.content,
                    idx,
                    &mut seen_user_messages,
                    &mut last_unkeyed_user,
                ) {
                    continue;
                }
            }
            if message.role == "tool" && message.id.starts_with("tool-result-") {
                if let Some(call_id) = message.tool_call_id.as_deref() {
                    if let Some(existing) =
                        messages.iter_mut().rev().find(|m: &&mut ChatMessage| {
                            m.role == "tool" && m.tool_call_id.as_deref() == Some(call_id)
                        })
                    {
                        existing.content = message.content.clone();
                        existing.tool_data = message.tool_data.clone();
                        existing.is_loading = Some(false);
                        continue;
                    }
                }
            }
            messages.push(message);
        }
    }

    // A Codex process killed mid-tool-execution (SIGKILL, OOM, power loss)
    // can leave `function_call` rows without their `function_call_output`
    // counterpart. They render as permanently-spinning tool rows in the UI.
    // For every tool row that still has `is_loading = true` after the merge
    // pass, look up whether its `call_id` has a matching tool_result; if
    // not, force `is_loading = false` so the UI stops spinning. The
    // unmatched `tool_input` is preserved so the user can still see what
    // the model attempted.
    close_orphan_codex_tool_calls(&mut messages);

    messages
}

fn keep_codex_user_message(
    payload: &Value,
    current_turn_id: Option<&str>,
    content: &str,
    source_index: usize,
    seen: &mut HashSet<String>,
    last_unkeyed: &mut Option<(String, usize)>,
) -> bool {
    let turn_id = payload
        .pointer("/internal_chat_message_metadata_passthrough/turn_id")
        .and_then(Value::as_str)
        .or(current_turn_id)
        .filter(|turn_id| !turn_id.trim().is_empty());
    if let Some(turn_id) = turn_id {
        return seen.insert(format!("{turn_id}\u{0}{content}"));
    }

    if last_unkeyed
        .as_ref()
        .is_some_and(|(last_content, last_index)| {
            last_content == content && source_index.saturating_sub(*last_index) <= 2
        })
    {
        return false;
    }
    *last_unkeyed = Some((content.to_string(), source_index));
    true
}

fn close_orphan_codex_tool_calls(messages: &mut [ChatMessage]) {
    use std::collections::HashSet;
    let matched: HashSet<String> = messages
        .iter()
        .filter(|m| m.role == "tool" && m.tool_name.as_deref() == Some("tool_result"))
        .filter_map(|m| m.tool_call_id.clone())
        .collect();
    for m in messages.iter_mut() {
        if m.role == "tool"
            && m.is_loading == Some(true)
            && m.tool_name.as_deref() != Some("tool_result")
        {
            if let Some(id) = m.tool_call_id.as_ref() {
                if !matched.contains(id) {
                    m.is_loading = Some(false);
                }
            }
        }
    }
}

fn paginate_codex_messages(
    messages: Vec<ChatMessage>,
    before_sequence: Option<i64>,
    limit: i64,
) -> ThreadMessagesPage {
    let total = messages.len();
    let limit = limit.clamp(1, 1000) as usize;
    let user_anchors = messages
        .iter()
        .enumerate()
        .filter_map(|(index, message)| (message.role == "user").then_some(index))
        .collect::<Vec<_>>();
    if !user_anchors.is_empty() {
        let upper_bound = before_sequence
            .map(|sequence| (sequence - 1).clamp(0, total as i64) as usize)
            .unwrap_or(total);
        let eligible_count = user_anchors.partition_point(|anchor| *anchor < upper_bound);
        if eligible_count == 0 {
            return ThreadMessagesPage {
                messages: Vec::new(),
                oldest_sequence: None,
                has_more: false,
            };
        }
        let first_anchor_position = eligible_count.saturating_sub(limit);
        let first_anchor = user_anchors[first_anchor_position];
        let start = if first_anchor_position == 0 {
            0
        } else {
            first_anchor
        };
        return ThreadMessagesPage {
            messages: messages[start..upper_bound].to_vec(),
            oldest_sequence: Some((first_anchor + 1) as i64),
            has_more: first_anchor_position > 0,
        };
    }

    let end = before_sequence
        .map(|sequence| (sequence - 1).clamp(0, total as i64) as usize)
        .unwrap_or(total);
    let start = end.saturating_sub(limit);
    let page_messages = if start < end {
        messages[start..end].to_vec()
    } else {
        Vec::new()
    };
    ThreadMessagesPage {
        messages: page_messages,
        oldest_sequence: (start < end).then_some((start + 1) as i64),
        has_more: start > 0,
    }
}

#[allow(dead_code)]
struct HistoryItem {
    session_id: String,
    text: String,
    ts: i64,
}

#[allow(dead_code)]
fn read_codex_history_items() -> Result<Vec<HistoryItem>, String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(Vec::new());
    };
    let path = home.join(".codex").join("history.jsonl");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut items = Vec::new();
    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(session_id) = value.get("session_id").and_then(Value::as_str) else {
            continue;
        };
        let raw_text = value
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("Codex Session");
        if is_hidden_codex_user_message(raw_text) {
            continue;
        }
        let text = raw_text.replace('\n', " ");
        let ts = value
            .get("ts")
            .and_then(Value::as_i64)
            .map(normalize_epoch_millis)
            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
        items.push(HistoryItem {
            session_id: session_id.to_string(),
            text: truncate_title(&text),
            ts,
        });
    }
    Ok(items)
}

#[allow(dead_code)]
struct SessionMeta {
    id: String,
    title: Option<String>,
    created_at: Option<i64>,
    updated_at: Option<i64>,
}

fn read_codex_session_meta(path: &Path) -> Result<SessionMeta, String> {
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut id = None;
    let mut title = None;
    let mut created_at = None;
    let mut updated_at = None;

    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(ts) = value
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_timestamp_millis)
        {
            created_at = created_at.or(Some(ts));
            updated_at = Some(ts);
        }
        match value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "session_meta" => {
                let payload = value.get("payload").unwrap_or(&value);
                id = payload
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or(id);
                if let Some(ts) = payload
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .and_then(parse_timestamp_millis)
                {
                    created_at = created_at.or(Some(ts));
                }
            }
            "response_item" => {
                if title.is_none() {
                    let payload = value.get("payload").unwrap_or(&value);
                    if payload.get("type").and_then(Value::as_str) == Some("message")
                        && payload.get("role").and_then(Value::as_str) == Some("user")
                    {
                        if let Some(text) = content_parts_to_text(payload.get("content")) {
                            if !is_hidden_codex_user_message(&text) {
                                title = Some(truncate_title(&text.replace('\n', " ")));
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let id = id
        .or_else(|| session_id_from_filename(path))
        .ok_or_else(|| "missing Codex session id".to_string())?;
    Ok(SessionMeta {
        id,
        title,
        created_at,
        updated_at,
    })
}

fn response_item_to_chat_message(
    session_id: &str,
    idx: usize,
    timestamp: &str,
    payload: &Value,
) -> Option<ChatMessage> {
    let item_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match item_type {
        "message" => {
            let role = payload
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if role != "user" && role != "assistant" {
                return None;
            }
            let content = content_parts_to_text(payload.get("content"))?;
            if content.trim().is_empty() {
                return None;
            }
            Some(base_message(
                format!("{session_id}-{idx}-{role}"),
                role,
                content,
                timestamp,
            ))
        }
        "function_call" | "custom_tool_call" => {
            let name = tool_event_name(payload, tool_event_definition(item_type), item_type);
            let call_id = payload
                .get("call_id")
                .and_then(Value::as_str)
                .unwrap_or(&name)
                .to_string();
            let input = payload
                .get("arguments")
                .or_else(|| payload.get("input"))
                .map(normalize_codex_value)
                .unwrap_or_else(|| payload.clone());
            let mut message =
                base_message(format!("tool-{call_id}"), "tool", String::new(), timestamp);
            message.tool_call_id = Some(call_id);
            message.tool_name = Some(name);
            message.tool_input = Some(input);
            message.is_loading = Some(true);
            Some(message)
        }
        "function_call_output" | "custom_tool_call_output" => {
            let call_id = payload
                .get("call_id")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string();
            let raw_output = payload
                .get("output")
                .map(codex_output_to_text)
                .unwrap_or_else(|| payload.to_string());
            let output_chars = raw_output.chars().count();
            let output_truncated = output_chars > MAX_HISTORY_TOOL_OUTPUT_CHARS;
            let output = truncate_history_tool_output(&raw_output);
            let data = serde_json::json!({
                "output": output,
                "output_chars": output_chars,
                "output_truncated": output_truncated,
            });
            let data_text =
                serde_json::to_string_pretty(&data).unwrap_or_else(|_| data.to_string());
            let mut message = base_message(
                format!("tool-result-{call_id}"),
                "tool",
                data_text.clone(),
                timestamp,
            );
            message.tool_call_id = Some(call_id);
            message.tool_name = Some("tool_result".to_string());
            message.tool_data = Some(data_text);
            message.is_loading = Some(false);
            Some(message)
        }
        "web_search_call" | "web_search" | "web_search_preview" | "search_query" => {
            let call_id = payload
                .get("call_id")
                .or_else(|| payload.get("id"))
                .and_then(Value::as_str)
                .unwrap_or("web_search")
                .to_string();
            let mut message =
                base_message(format!("tool-{call_id}"), "tool", String::new(), timestamp);
            message.tool_call_id = Some(call_id);
            message.tool_name = Some("web_search".to_string());
            message.tool_input = Some(payload.clone());
            message.is_loading = Some(false);
            Some(message)
        }
        "reasoning" => {
            let summary = payload
                .get("summary")
                .and_then(Value::as_array)
                .and_then(|items| {
                    let text = items
                        .iter()
                        .filter_map(|item| item.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("\n");
                    (!text.trim().is_empty()).then_some(text)
                })?;
            let mut message = base_message(
                format!("{session_id}-{idx}-reasoning"),
                "reasoning",
                summary,
                timestamp,
            );
            message.is_completed = Some(true);
            Some(message)
        }
        _ => {
            let definition = tool_event_definition(item_type);
            match definition.map(|definition| definition.mode) {
                Some(CodexToolEventMode::Call) => {
                    Some(history_tool_call_message(timestamp, payload, item_type))
                }
                Some(CodexToolEventMode::Result) => {
                    Some(history_tool_result_message(timestamp, payload, item_type))
                }
                Some(CodexToolEventMode::Lifecycle | CodexToolEventMode::Complete) => Some(
                    completed_history_tool_message(timestamp, payload, item_type),
                ),
                None if looks_like_unknown_tool_event(item_type, payload) => {
                    if item_type.ends_with("_output") || item_type.ends_with("_result") {
                        Some(history_tool_result_message(timestamp, payload, item_type))
                    } else {
                        Some(completed_history_tool_message(
                            timestamp, payload, item_type,
                        ))
                    }
                }
                None => None,
            }
        }
    }
}

fn history_tool_call_message(timestamp: &str, payload: &Value, item_type: &str) -> ChatMessage {
    let definition = tool_event_definition(item_type);
    let call_id = tool_event_id(payload, item_type);
    let mut message = base_message(format!("tool-{call_id}"), "tool", String::new(), timestamp);
    message.tool_call_id = Some(call_id);
    message.tool_name = Some(tool_event_name(payload, definition, item_type));
    message.tool_input = Some(history_tool_input(payload, item_type));
    message.is_loading = Some(true);
    message
}

fn history_tool_result_message(timestamp: &str, payload: &Value, item_type: &str) -> ChatMessage {
    let call_id = tool_event_id(payload, item_type);
    let data_text = history_tool_data(&history_tool_output(payload, item_type));
    let mut message = base_message(
        format!("tool-result-{call_id}"),
        "tool",
        data_text.clone(),
        timestamp,
    );
    message.tool_call_id = Some(call_id);
    message.tool_name = Some("tool_result".to_string());
    message.tool_data = Some(data_text);
    message.is_loading = Some(false);
    message
}

fn completed_history_tool_message(
    timestamp: &str,
    payload: &Value,
    item_type: &str,
) -> ChatMessage {
    let definition = tool_event_definition(item_type);
    let call_id = tool_event_id(payload, item_type);
    let name = tool_event_name(payload, definition, item_type);
    let input = history_tool_input(payload, item_type);
    let raw_output = history_tool_output(payload, item_type);
    let data_text = history_tool_data(&raw_output);
    let mut message = base_message(
        format!("tool-{call_id}"),
        "tool",
        data_text.clone(),
        timestamp,
    );
    message.tool_call_id = Some(call_id);
    message.tool_name = Some(name);
    message.tool_input = Some(input);
    message.tool_data = Some(data_text);
    message.is_loading = Some(false);
    message
}

fn history_tool_input(payload: &Value, item_type: &str) -> Value {
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
            .map(normalize_codex_value)
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
    if let Some(arguments) = payload
        .get("invocation")
        .and_then(|invocation| invocation.get("arguments"))
    {
        return normalize_codex_value(arguments);
    }
    for key in [
        "arguments",
        "input",
        "params",
        "action",
        "query",
        "prompt",
        "changes",
    ] {
        if let Some(value) = payload.get(key) {
            return normalize_codex_value(value);
        }
    }
    history_fallback_payload(payload, item_type)
}

fn history_tool_output(payload: &Value, item_type: &str) -> String {
    for key in [
        "output",
        "aggregated_output",
        "result",
        "content",
        "changes",
    ] {
        if let Some(value) = payload.get(key) {
            return codex_output_to_text(value);
        }
    }
    history_fallback_payload(payload, item_type).to_string()
}

fn history_fallback_payload(payload: &Value, item_type: &str) -> Value {
    let raw = payload.to_string();
    let raw_chars = raw.chars().count();
    serde_json::json!({
        "codex_item_type": item_type,
        "raw_payload_chars": raw_chars,
        "raw_payload_truncated": raw_chars > MAX_HISTORY_TOOL_OUTPUT_CHARS,
        "raw_payload_preview": truncate_history_tool_output(&raw),
    })
}

fn history_tool_data(raw_output: &str) -> String {
    let output_chars = raw_output.chars().count();
    let output_truncated = output_chars > MAX_HISTORY_TOOL_OUTPUT_CHARS;
    let output = truncate_history_tool_output(raw_output);
    let data = serde_json::json!({
        "output": output,
        "output_chars": output_chars,
        "output_truncated": output_truncated,
    });
    serde_json::to_string_pretty(&data).unwrap_or_else(|_| data.to_string())
}

fn normalize_codex_value(value: &Value) -> Value {
    value
        .as_str()
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .unwrap_or_else(|| value.clone())
}

/// Newer Codex custom-tool outputs are content-block arrays rather than a
/// plain string. Flatten their textual blocks so restored Thread Cards show
/// the same useful output as the live tool row.
fn codex_output_to_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(items) => {
            let parts = items
                .iter()
                .filter_map(|item| {
                    item.get("text")
                        .or_else(|| item.get("content"))
                        .and_then(Value::as_str)
                })
                .collect::<Vec<_>>();
            if parts.is_empty() {
                value.to_string()
            } else {
                parts.join("")
            }
        }
        _ => value.to_string(),
    }
}

fn event_msg_to_chat_message(
    session_id: &str,
    idx: usize,
    timestamp: &str,
    payload: &Value,
) -> Option<ChatMessage> {
    let item_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match item_type {
        "user_message" => payload.get("message").and_then(Value::as_str).map(|text| {
            base_message(
                format!("{session_id}-{idx}-user-event"),
                "user",
                text.to_string(),
                timestamp,
            )
        }),
        _ => {
            let definition = tool_event_definition(item_type);
            if definition.is_some() || looks_like_unknown_tool_event(item_type, payload) {
                Some(completed_history_tool_message(
                    timestamp, payload, item_type,
                ))
            } else {
                None
            }
        }
    }
}

fn base_message(id: String, role: &str, content: String, timestamp: &str) -> ChatMessage {
    ChatMessage {
        id,
        role: role.to_string(),
        content,
        llm_content: None,
        system_reminder_directory: None,
        timestamp: if timestamp.is_empty() {
            chrono::Utc::now().to_rfc3339()
        } else {
            timestamp.to_string()
        },
        is_loading: None,
        tool_call_id: None,
        tool_name: None,
        tool_data: None,
        tool_input: None,
        tool_calls: None,
        reasoning: None,
        is_completed: None,
        is_collapsed: None,
    }
}

fn content_parts_to_text(content: Option<&Value>) -> Option<String> {
    match content? {
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

/// Codex 会把运�?�??和插件推荐作�?user 消息写入 rollout JSONL�?/// 这些消息�?��行时上下文，不是用户输入，不应进入聊天�?录或会话标�?�?
fn is_hidden_codex_user_message(content: &str) -> bool {
    let content = content.trim_start();
    content.starts_with("<recommended_plugins>") || content.starts_with("<environment_context>")
}

mod files;
pub use files::codex_session_cwd;
#[cfg(test)]
use files::codex_session_cwd_in;
use files::{
    codex_session_files, find_codex_session_file, normalize_epoch_millis, parse_timestamp_millis,
    session_id_from_filename, truncate_history_tool_output, truncate_title,
};

#[cfg(test)]
mod tests;
