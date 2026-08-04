use std::time::Duration;

use serde_json::Value;
use tokio::process::Command;

use super::binary::resolve_opencode_binary;
use crate::agent_external::shared::configure_unix_process_group;
use crate::agent_session::{ChatMessage, ThreadMessagesPage};

const EXPORT_TIMEOUT: Duration = Duration::from_secs(30);

/// Read OpenCode's own durable transcript for display-only fallback. Nothing
/// from this path is written back into Flowix storage.
pub async fn get_session_page(
    session_id: &str,
    before_sequence: Option<i64>,
    limit: i64,
) -> Result<ThreadMessagesPage, String> {
    let mut command = Command::new(resolve_opencode_binary());
    command.arg("export").arg(session_id).kill_on_drop(true);
    configure_unix_process_group(&mut command);
    crate::process_window::hide_command_window(&mut command);

    let output = tokio::time::timeout(EXPORT_TIMEOUT, command.output())
        .await
        .map_err(|_| "OpenCode history export timed out".to_string())?
        .map_err(|error| format!("failed to export OpenCode session: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("OpenCode session export failed: {}", stderr.trim()));
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("invalid OpenCode session export: {error}"))?;
    let mut turns = export_to_turns(&value);
    for turn in &mut turns {
        crate::agent_external::canonicalize_imported_messages(
            "opencode",
            session_id,
            turn,
        );
    }
    Ok(paginate_turns(turns, before_sequence, limit))
}

fn export_to_turns(value: &Value) -> Vec<Vec<ChatMessage>> {
    let mut turns: Vec<Vec<ChatMessage>> = Vec::new();
    for message in value
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let info = message.get("info").unwrap_or(&Value::Null);
        let role = info.get("role").and_then(Value::as_str).unwrap_or_default();
        let message_id = info
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("opencode-message");
        let created_at = info
            .pointer("/time/created")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        let parts = message
            .get("parts")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();

        if role == "user" {
            let content = parts
                .iter()
                .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            turns.push(vec![history_message(
                message_id.to_string(),
                "user",
                visible_user_text(&content),
                created_at,
            )]);
            continue;
        }
        if role != "assistant" {
            continue;
        }
        if turns.is_empty() {
            turns.push(Vec::new());
        }
        let turn = turns.last_mut().expect("turn initialized");
        for (index, part) in parts.iter().enumerate() {
            let part_type = part.get("type").and_then(Value::as_str);
            let part_id = part
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("{message_id}-part-{index}"));
            let timestamp = part
                .pointer("/time/start")
                .and_then(Value::as_i64)
                .unwrap_or(created_at);
            match part_type {
                Some("text") | Some("reasoning") => {
                    let content = part
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    if !content.is_empty() {
                        turn.push(history_message(
                            part_id,
                            if part_type == Some("reasoning") {
                                "reasoning"
                            } else {
                                "assistant"
                            },
                            content,
                            timestamp,
                        ));
                    }
                }
                Some("tool") => turn.push(tool_message(part_id, part, timestamp)),
                _ => {}
            }
        }
    }
    turns
}

fn tool_message(id: String, part: &Value, timestamp: i64) -> ChatMessage {
    let state = part.get("state").unwrap_or(&Value::Null);
    let status = state
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let result = state
        .get("output")
        .or_else(|| state.get("error"))
        .cloned()
        .unwrap_or(Value::Null);
    let content = result.as_str().map(str::to_string).unwrap_or_else(|| {
        if result.is_null() {
            String::new()
        } else {
            result.to_string()
        }
    });
    let mut message = history_message(id, "tool", content.clone(), timestamp);
    message.tool_call_id = part
        .get("callID")
        .and_then(Value::as_str)
        .map(str::to_string);
    message.tool_name = part.get("tool").and_then(Value::as_str).map(str::to_string);
    message.tool_input = state.get("input").cloned();
    message.tool_data = (!content.is_empty()).then_some(content);
    let completed = matches!(status, "completed" | "error" | "failed");
    message.is_loading = Some(!completed);
    message.is_completed = Some(completed);
    message
}

fn visible_user_text(content: &str) -> String {
    const MARKERS: [&str; 2] = ["\n<## CONTEXT PROMPT ##>", "\n\n[Flowix workspace context]"];
    let end = MARKERS
        .iter()
        .filter_map(|marker| content.find(marker))
        .min()
        .unwrap_or(content.len());
    content[..end].trim_end().to_string()
}

fn history_message(id: String, role: &str, content: String, timestamp: i64) -> ChatMessage {
    ChatMessage {
        id,
        role: role.to_string(),
        content,
        llm_content: None,
        system_reminder_directory: None,
        timestamp: chrono::DateTime::from_timestamp_millis(timestamp)
            .unwrap_or_default()
            .to_rfc3339(),
        is_loading: None,
        tool_call_id: None,
        tool_name: None,
        tool_data: None,
        tool_input: None,
        tool_calls: None,
        reasoning: None,
        is_completed: Some(true),
        is_collapsed: None,
    }
}

fn paginate_turns(
    turns: Vec<Vec<ChatMessage>>,
    before_sequence: Option<i64>,
    limit: i64,
) -> ThreadMessagesPage {
    let total = turns.len();
    let end = before_sequence
        .map(|sequence| (sequence - 1).clamp(0, total as i64) as usize)
        .unwrap_or(total);
    let start = end.saturating_sub(limit.clamp(1, 50) as usize);
    ThreadMessagesPage {
        messages: turns[start..end].iter().flatten().cloned().collect(),
        oldest_sequence: (start < end).then_some((start + 1) as i64),
        has_more: start > 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_export_parts_and_strips_injected_user_context() {
        let value = serde_json::json!({
            "messages": [
                {
                    "info": {"id": "user-1", "role": "user", "time": {"created": 1000}},
                    "parts": [{"type": "text", "text": "hello\n\n[Flowix workspace context]\ninternal"}]
                },
                {
                    "info": {"id": "assistant-1", "role": "assistant", "time": {"created": 2000}},
                    "parts": [
                        {"id": "reason-1", "type": "reasoning", "text": "think"},
                        {"id": "tool-1", "type": "tool", "tool": "read", "callID": "call-1", "state": {"status": "completed", "input": {"filePath": "/tmp/a"}, "output": "ok"}},
                        {"id": "text-1", "type": "text", "text": "done"}
                    ]
                }
            ]
        });
        let turns = export_to_turns(&value);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0][0].content, "hello");
        assert_eq!(turns[0][1].role, "reasoning");
        assert_eq!(turns[0][2].tool_call_id.as_deref(), Some("call-1"));
        assert_eq!(
            turns[0][2].tool_input.as_ref().unwrap()["filePath"],
            "/tmp/a"
        );
        assert_eq!(turns[0][3].content, "done");
    }

    #[test]
    fn paginates_complete_user_turns() {
        let turns = (0..3)
            .map(|index| {
                vec![history_message(
                    format!("u-{index}"),
                    "user",
                    index.to_string(),
                    0,
                )]
            })
            .collect();
        let latest = paginate_turns(turns, None, 2);
        assert_eq!(latest.messages[0].content, "1");
        assert_eq!(latest.oldest_sequence, Some(2));
        assert!(latest.has_more);
    }
}
