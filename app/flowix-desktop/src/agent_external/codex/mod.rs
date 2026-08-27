mod app_server;
mod binary;
mod command;

pub const AGENT_TYPE: &str = "codex";
pub const MAX_TOOL_OUTPUT_CHARS: usize = 64 * 1024;
pub const MAX_UI_OUTPUT_PREVIEW_CHARS: usize = 4096;
pub use crate::agent_external::MAX_STDOUT_LINE_BYTES;

// Long-lived Codex App Server runtime.
pub use app_server::CodexAppServerManager;
pub(crate) use binary::resolve_codex_binary;
pub(crate) use command::preflight_codex;
