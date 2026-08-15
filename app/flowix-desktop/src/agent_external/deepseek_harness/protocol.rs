use serde_json::{json, Value};

use crate::agent_flowix::{AgentChunk, UsageInfo};

pub const HOST_PROTOCOL_VERSION: u64 = 1;

pub fn initialize_request(id: u64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "host.initialize",
        "params": {
            "protocolVersion": HOST_PROTOCOL_VERSION,
            "client": { "name": "flowix-desktop", "version": env!("CARGO_PKG_VERSION") }
        }
    })
}

pub fn runtime_ensure_request(
    id: u64,
    thread_id: &str,
    session_id: &str,
    cwd: &str,
    workspace_paths: &[String],
    provider: &str,
    provider_name: &str,
    api_protocol: &str,
    base_url: &str,
    model: &str,
    agent_preset: &str,
    permission_mode: &str,
) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "runtime.ensure",
        "params": {
            "threadId": thread_id,
            "sessionId": session_id,
            "cwd": cwd,
            "workspacePaths": workspace_paths,
            "provider": provider,
            "providerName": provider_name,
            "apiProtocol": api_protocol,
            "baseUrl": base_url,
            "model": model,
            "agentPreset": agent_preset,
            "permissionMode": permission_mode
        }
    })
}

pub fn run_start_request(id: u64, thread_id: &str, run_id: &str, prompt: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "run.start",
        "params": {
            "threadId": thread_id,
            "runId": run_id,
            "prompt": { "text": prompt }
        }
    })
}

pub fn run_cancel_request(id: u64, thread_id: &str, run_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "run.cancel",
        "params": { "threadId": thread_id, "runId": run_id }
    })
}

pub fn shutdown_request(id: u64) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "host.shutdown", "params": {} })
}

pub fn response_result(message: &Value) -> Option<Result<Value, String>> {
    message.get("id")?;
    if let Some(error) = message.get("error") {
        return Some(Err(error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("dsh-host request failed")
            .to_string()));
    }
    Some(Ok(message.get("result").cloned().unwrap_or(Value::Null)))
}

pub fn event_route(message: &Value) -> Option<(String, String)> {
    if message.get("method").and_then(Value::as_str) != Some("run.event") {
        return None;
    }
    Some((
        message.pointer("/params/threadId")?.as_str()?.to_string(),
        message.pointer("/params/runId")?.as_str()?.to_string(),
    ))
}

pub enum AdaptedEvent {
    Chunk(AgentChunk),
    Completed(Option<String>),
    Ignore,
}

/// Some OpenAI-compatible reasoning models do not expose a separate
/// `reasoning_content` stream. They wrap the reasoning in `<think>...</think>`
/// inside ordinary assistant text instead. Keep this normalization at the
/// Harness boundary so live rendering and persisted history use the same role.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ThinkingSegment {
    Text(String),
    Reasoning(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ThinkingMode {
    Text,
    Reasoning,
}

pub(crate) struct ThinkingTagParser {
    mode: ThinkingMode,
    pending: String,
}

impl ThinkingTagParser {
    pub(crate) fn new() -> Self {
        Self {
            mode: ThinkingMode::Text,
            pending: String::new(),
        }
    }

    pub(crate) fn push(&mut self, text: &str) -> Vec<ThinkingSegment> {
        if text.is_empty() {
            return Vec::new();
        }
        self.pending.push_str(text);
        self.drain_pending()
    }

    /// Flush a partial tag at a protocol boundary as literal content while
    /// preserving the current thinking mode for the next text delta.
    pub(crate) fn flush_pending(&mut self) -> Vec<ThinkingSegment> {
        if self.pending.is_empty() {
            return Vec::new();
        }
        let text = std::mem::take(&mut self.pending);
        vec![self.segment(text)]
    }

    /// Flush the final unterminated segment and reset for a future run.
    pub(crate) fn finish(&mut self) -> Vec<ThinkingSegment> {
        let segments = self.flush_pending();
        self.mode = ThinkingMode::Text;
        segments
    }

    fn drain_pending(&mut self) -> Vec<ThinkingSegment> {
        let mut segments = Vec::new();
        loop {
            let marker = match self.mode {
                ThinkingMode::Text => "<think>",
                ThinkingMode::Reasoning => "</think>",
            };
            if let Some(index) = self.pending.find(marker) {
                if index > 0 {
                    let before = self.pending[..index].to_string();
                    segments.push(self.segment(before));
                }
                self.pending.drain(..index + marker.len());
                self.mode = match self.mode {
                    ThinkingMode::Text => ThinkingMode::Reasoning,
                    ThinkingMode::Reasoning => ThinkingMode::Text,
                };
                continue;
            }

            let keep = longest_marker_prefix_suffix(&self.pending, marker);
            if keep == 0 {
                let text = std::mem::take(&mut self.pending);
                if !text.is_empty() {
                    segments.push(self.segment(text));
                }
            } else {
                let emit_len = self.pending.len() - keep;
                if emit_len > 0 {
                    let text = self.pending[..emit_len].to_string();
                    self.pending.drain(..emit_len);
                    segments.push(self.segment(text));
                }
            }
            break;
        }
        segments
    }

    fn segment(&self, text: String) -> ThinkingSegment {
        match self.mode {
            ThinkingMode::Text => ThinkingSegment::Text(text),
            ThinkingMode::Reasoning => ThinkingSegment::Reasoning(text),
        }
    }
}

fn longest_marker_prefix_suffix(value: &str, marker: &str) -> usize {
    (1..marker.len())
        .rev()
        .find(|length| value.ends_with(&marker[..*length]))
        .unwrap_or(0)
}

pub fn adapt_event(message: &Value, delivery_thread_id: &str) -> AdaptedEvent {
    let Some(event) = message.pointer("/params/event") else {
        return AdaptedEvent::Ignore;
    };
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let thread_id = delivery_thread_id.to_string();
    match event_type {
        "session.resolved" => event
            .get("sessionId")
            .and_then(Value::as_str)
            .map(|session_id| {
                AdaptedEvent::Chunk(AgentChunk::SessionResolved {
                    thread_id,
                    session_id: session_id.to_string(),
                })
            })
            .unwrap_or(AdaptedEvent::Ignore),
        "assistant.delta" => text_chunk(event, thread_id, false),
        "reasoning.delta" => text_chunk(event, thread_id, true),
        "tool.started" => {
            let Some(id) = event.get("id").and_then(Value::as_str) else {
                return AdaptedEvent::Ignore;
            };
            let name = event.get("name").and_then(Value::as_str).unwrap_or("tool");
            AdaptedEvent::Chunk(AgentChunk::ToolCall {
                thread_id,
                id: id.to_string(),
                name: name.to_string(),
                input: event.get("input").cloned().unwrap_or_else(|| json!({})),
            })
        }
        "tool.completed" => {
            let Some(id) = event.get("id").and_then(Value::as_str) else {
                return AdaptedEvent::Ignore;
            };
            let name = event.get("name").and_then(Value::as_str).unwrap_or("tool");
            AdaptedEvent::Chunk(AgentChunk::ToolResult {
                thread_id,
                id: id.to_string(),
                name: name.to_string(),
                result: event.get("result").cloned().unwrap_or(Value::Null),
            })
        }
        "usage" => {
            let input = u32_field(event, "inputTokens");
            let cache_read = u32_field(event, "cacheReadTokens");
            let cache_write = u32_field(event, "cacheWriteTokens");
            let cached = match (cache_read, cache_write) {
                (None, None) => None,
                (read, write) => Some(read.unwrap_or(0).saturating_add(write.unwrap_or(0))),
            };
            let output = u32_field(event, "outputTokens");
            let reasoning = u32_field(event, "reasoningTokens");
            AdaptedEvent::Chunk(AgentChunk::Usage {
                thread_id,
                model_id: None,
                last_run_at: Some(chrono::Utc::now().timestamp_millis()),
                usage: Some(UsageInfo {
                    input_tokens: input,
                    cached_input_tokens: cached,
                    output_tokens: output,
                    reasoning_output_tokens: reasoning,
                    total_tokens: Some(
                        input
                            .unwrap_or(0)
                            .saturating_add(cached.unwrap_or(0))
                            .saturating_add(output.unwrap_or(0)),
                    ),
                    model_context_window: None,
                }),
                status_info: None,
            })
        }
        "run.error" => AdaptedEvent::Chunk(AgentChunk::Error {
            thread_id,
            message: event
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("DeepSeek Harness run failed")
                .to_string(),
        }),
        "run.completed" => AdaptedEvent::Completed(
            event
                .get("reason")
                .and_then(Value::as_str)
                .map(str::to_string),
        ),
        _ => AdaptedEvent::Ignore,
    }
}

fn text_chunk(event: &Value, thread_id: String, reasoning: bool) -> AdaptedEvent {
    let Some(text) = event.get("text").and_then(Value::as_str) else {
        return AdaptedEvent::Ignore;
    };
    if reasoning {
        AdaptedEvent::Chunk(AgentChunk::Reasoning {
            thread_id,
            text: text.to_string(),
        })
    } else {
        AdaptedEvent::Chunk(AgentChunk::Text {
            thread_id,
            text: text.to_string(),
        })
    }
}

fn u32_field(value: &Value, key: &str) -> Option<u32> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_host_delta_to_agent_chunk() {
        let event = json!({
            "method": "run.event",
            "params": { "event": { "type": "assistant.delta", "text": "hello" } }
        });
        assert!(matches!(
            adapt_event(&event, "thread-1"),
            AdaptedEvent::Chunk(AgentChunk::Text { text, .. }) if text == "hello"
        ));
    }

    #[test]
    fn splits_think_tags_even_when_they_cross_text_deltas() {
        let mut parser = ThinkingTagParser::new();
        let mut segments = parser.push("<thi");
        segments.extend(parser.push("nk>think").into_iter());
        segments.extend(parser.push("ing</think>answer").into_iter());
        segments.extend(parser.finish());

        assert_eq!(
            segments,
            vec![
                ThinkingSegment::Reasoning("think".to_string()),
                ThinkingSegment::Reasoning("ing".to_string()),
                ThinkingSegment::Text("answer".to_string()),
            ]
        );
    }

    #[test]
    fn keeps_unclosed_think_content_as_reasoning() {
        let mut parser = ThinkingTagParser::new();
        assert_eq!(
            parser.push("<think>still thinking"),
            vec![ThinkingSegment::Reasoning("still thinking".to_string())]
        );
        assert_eq!(parser.finish(), Vec::<ThinkingSegment>::new());
    }

    #[test]
    fn maps_host_usage_to_flowix_usage() {
        let event = json!({
            "method": "run.event",
            "params": { "event": { "type": "usage", "inputTokens": 2, "cacheReadTokens": 3, "cacheWriteTokens": 4, "outputTokens": 5 } }
        });
        assert!(matches!(
            adapt_event(&event, "thread-1"),
            AdaptedEvent::Chunk(AgentChunk::Usage {
                usage: Some(UsageInfo {
                    cached_input_tokens: Some(7),
                    total_tokens: Some(14),
                    ..
                }),
                ..
            })
        ));
    }
}
