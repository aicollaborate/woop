mod binary;
mod command;
mod history;
mod protocol;
mod runtime;

pub use binary::resolve_opencode_binary;
pub use runtime::OpenCodeAcpManager;

pub const AGENT_TYPE: &str = "opencode";
