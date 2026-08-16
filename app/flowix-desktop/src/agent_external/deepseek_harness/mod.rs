mod host;
mod manager;
mod protocol;

pub use manager::{resolve_runtime_config, DeepSeekHarnessManager, DeepSeekHarnessSessionUsage};

pub const AGENT_TYPE: &str = "deepseek-harness";
