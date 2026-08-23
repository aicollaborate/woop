use crate::agent_external::runtime_registry::ExternalCliRuntime;
use crate::agent_wire::AgentUserMessage;
use crate::app::state::AppState;

/// Chat dispatch target. The former built-in runtime was removed; every
/// supported agent is an external CLI runtime now.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum AgentRuntime {
    Codex,
    Claude,
    Hermes,
    OpenCode,
    DeepSeekHarness,
}

impl AgentRuntime {
    /// Parse the frontend `agentType` payload. Unknown / missing values are
    /// an error ── silently defaulting would hide a stale caller or revive
    /// the removed built-in runtime.
    pub(super) fn from_agent_type(agent_type: Option<&str>) -> Result<Self, String> {
        let raw = agent_type
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "agent type is required".to_string())?;
        match raw.to_ascii_lowercase().as_str() {
            "codex" => Ok(Self::Codex),
            "claude" => Ok(Self::Claude),
            "hermes" => Ok(Self::Hermes),
            "opencode" => Ok(Self::OpenCode),
            "deepseek-harness" | "deepseek_harness" | "dsh" => Ok(Self::DeepSeekHarness),
            other => Err(format!("unsupported agent type: {other}")),
        }
    }

    pub(super) fn from_message(message: &AgentUserMessage) -> Result<Self, String> {
        Self::from_agent_type(message.agent_type.as_deref())
    }

    pub(super) fn key(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Hermes => "hermes",
            Self::OpenCode => "opencode",
            Self::DeepSeekHarness => "deepseek-harness",
        }
    }
}

pub(super) enum RuntimeHandle<'a> {
    External(&'a dyn ExternalCliRuntime),
}

#[async_trait::async_trait]
pub(super) trait ChatRuntime {
    async fn chat_stream(
        &self,
        thread_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<String, String>;
    async fn stop_chat(
        &self,
        thread_id: &str,
        run_id: Option<&str>,
        app_handle: &tauri::AppHandle,
    ) -> bool;
}

#[async_trait::async_trait]
impl ChatRuntime for RuntimeHandle<'_> {
    async fn chat_stream(
        &self,
        thread_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<String, String> {
        match self {
            Self::External(runtime) => runtime.chat_stream(thread_id, message, app_handle).await,
        }
    }

    async fn stop_chat(
        &self,
        thread_id: &str,
        run_id: Option<&str>,
        app_handle: &tauri::AppHandle,
    ) -> bool {
        match self {
            Self::External(runtime) => runtime.stop_chat(thread_id, run_id, app_handle).await,
        }
    }
}

pub(super) fn runtime_handle<'a>(state: &'a AppState, runtime: AgentRuntime) -> RuntimeHandle<'a> {
    RuntimeHandle::External(
        state
            .external_runtimes
            .get(runtime.key())
            .expect("every external AgentRuntime must be registered"),
    )
}

/// Start an Agent runtime without exposing the conversation-specific command
/// contract to plugin callers. The runtime keeps its existing persistence and
/// lifecycle semantics; the plugin coordinator owns the result collection.
pub(crate) async fn start_plugin_chat(
    state: &AppState,
    thread_id: &str,
    message: AgentUserMessage,
    app_handle: &tauri::AppHandle,
) -> Result<(), String> {
    let runtime = AgentRuntime::from_message(&message)?;
    runtime_handle(state, runtime)
        .chat_stream(thread_id, message, app_handle)
        .await
        .map(|_| ())
}

pub(crate) async fn stop_any_runtime_chat(
    thread_id: &str,
    state: &AppState,
    app_handle: &tauri::AppHandle,
) -> bool {
    state
        .external_runtimes
        .stop_chat_all(thread_id, app_handle)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message_with_agent_type(agent_type: Option<&str>) -> AgentUserMessage {
        AgentUserMessage {
            content: "hello".to_string(),
            llm_content: None,
            image_paths: vec![],
            run_id: None,
            system_reminder_directory: None,
            agent_type: agent_type.map(str::to_string),
            runtime_config: None,
            permission_mode: None,
            codex_model: None,
            codex_reasoning_effort: None,
            conversation_title: None,
        }
    }

    #[test]
    fn agent_runtime_normalizes_known_agent_types() {
        let cases = [
            ("codex", AgentRuntime::Codex),
            (" CODEX ", AgentRuntime::Codex),
            ("Claude", AgentRuntime::Claude),
            ("HERMES", AgentRuntime::Hermes),
            ("opencode", AgentRuntime::OpenCode),
            ("DEEPSEEK-HARNESS", AgentRuntime::DeepSeekHarness),
            ("dsh", AgentRuntime::DeepSeekHarness),
        ];

        for (agent_type, expected) in cases {
            assert_eq!(
                AgentRuntime::from_message(&message_with_agent_type(Some(agent_type))).unwrap(),
                expected,
                "agent_type {agent_type:?} should map to {expected:?}"
            );
        }
    }

    #[test]
    fn agent_runtime_rejects_removed_flowix_type() {
        assert!(AgentRuntime::from_message(&message_with_agent_type(Some("flowix"))).is_err());
        assert!(AgentRuntime::from_message(&message_with_agent_type(None)).is_err());
        assert!(
            AgentRuntime::from_message(&message_with_agent_type(Some("unknown-agent"))).is_err()
        );
    }
}
