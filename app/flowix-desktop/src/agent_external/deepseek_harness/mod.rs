mod catalog;
mod app_server;
mod config;
mod discovery;
mod error;
mod event_adapter;
mod host_registry;
mod manager;
mod probe;
mod protocol;
mod run_coordinator;
mod run_projector;
mod session_registry;
mod transport;

pub use config::resolve_runtime_config;
pub use manager::{DeepSeekHarnessManager, DeepSeekHarnessSessionUsage};

pub const AGENT_TYPE: &str = "deepseek-harness";
