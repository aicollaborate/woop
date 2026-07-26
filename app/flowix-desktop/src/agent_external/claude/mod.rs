mod binary;
mod command;
mod events;
mod history;
mod stream;

pub const AGENT_TYPE: &str = "claude";

// History API —— 读取 ~/.claude/projects/<encoded>/*.jsonl，还原为 ChatMessage 流。
pub use history::{get_session, is_claude_session_id, list_sessions};

// CLI runtime —— spawn `claude` 子进程，按行解析 stdout，经 shared::emit_chunk_with_run_id
// 投递 AgentChunk。
pub mod cli;
pub use cli::ClaudeCliManager;
