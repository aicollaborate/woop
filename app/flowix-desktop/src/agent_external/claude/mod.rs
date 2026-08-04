mod binary;
mod command;
mod events;
mod history;
mod stream;

pub const AGENT_TYPE: &str = "claude";

// History API —— 读取 ~/.claude/projects/<encoded>/*.jsonl，还原为 ChatMessage 流。
pub use history::{get_session, get_session_page, is_claude_session_id};

// CLI runtime —— spawn `claude` 子进程，按行解析 stdout，经 shared::emit_chunk_with_run_id
// 投递 AgentChunk。
pub mod cli;
pub use cli::ClaudeCliManager;

// [both paths] tool_result envelope 共用逻辑 -- events.rs 的
// `claude_tool_result_value` 与 history.rs 的 `claude_tool_result_content`
// 都调这里给 envelope 补 `is_error` 字段。
pub(crate) fn claude_tool_result_envelope(
    mut value: serde_json::Value,
    source: &serde_json::Value,
) -> serde_json::Value {
    if let Some(is_error) = source.get("is_error").and_then(serde_json::Value::as_bool) {
        match &mut value {
            serde_json::Value::Object(map) => {
                map.insert("is_error".to_string(), serde_json::Value::Bool(is_error));
            }
            _ => {
                value = serde_json::json!({
                    "content": value,
                    "is_error": is_error,
                });
            }
        }
    }
    value
}
