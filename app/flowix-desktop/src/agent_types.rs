use serde::{Deserialize, Serialize};

/// Agent id newtype used on the wire as a plain string.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AgentId(pub String);

impl AgentId {
    pub fn new(s: &str) -> Self {
        Self(s.to_string())
    }
}

impl std::fmt::Display for AgentId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<String> for AgentId {
    fn from(s: String) -> Self {
        Self(s)
    }
}

impl From<&str> for AgentId {
    fn from(s: &str) -> Self {
        Self(s.to_string())
    }
}

/// 线程�?`agent_id` 列的固定占位值。所有新�?thread 都写�?`"default"`�?///
/// 用函数而非 `pub const` �?���?`String` 不能�?const 上下文构�? 调用�?/// 应缓存返回�? 不�?每�?都重新分配�?
pub fn default_agent_id() -> AgentId {
    AgentId::new("default")
}

/// Token usage breakdown shared by agent streaming events and persisted run state.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "snake_case")]
pub struct UsageInfo {
    pub input_tokens: Option<u32>,
    pub cached_input_tokens: Option<u32>,
    pub output_tokens: Option<u32>,
    pub reasoning_output_tokens: Option<u32>,
    pub total_tokens: Option<u32>,
    pub model_context_window: Option<u32>,
}

/// Provider-specific status snapshot shared by agent streaming events and
/// persisted run state.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "snake_case")]
pub struct StatusInfo {
    pub codex_plan_type: Option<String>,
    pub codex_used_percent: Option<f64>,
    pub codex_resets_at: Option<i64>,
}
