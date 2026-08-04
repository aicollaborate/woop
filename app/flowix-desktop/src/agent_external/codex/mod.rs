pub mod binary;
pub mod cli;
mod command;
pub mod events;
pub mod history;
pub mod runtime;
mod stream;
mod tool_events;

pub const AGENT_TYPE: &str = "codex";
pub const MAX_TOOL_OUTPUT_CHARS: usize = 64 * 1024;
pub const MAX_UI_OUTPUT_PREVIEW_CHARS: usize = 4096;
pub use crate::agent_external::MAX_STDOUT_LINE_BYTES;

// CLI runtime —— spawn `codex` 子进程，按 JSONL 行解析 stdout。
pub use cli::CodexCliManager;

// History API —— 读取 ~/.codex/sessions/* 下的 jsonl，还原为 ChatMessage 流。
pub use history::{get_session, get_session_page, is_codex_session_id};
