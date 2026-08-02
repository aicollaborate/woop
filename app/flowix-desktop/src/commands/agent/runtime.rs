use std::sync::Arc;

use async_trait::async_trait;

use crate::agent_external::runtime_registry::ExternalCliRuntime;
use crate::agent_flowix::{AgentManager, AgentUserMessage};
use crate::app::state::AppState;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum AgentRuntime {
    Flowix,
    Codex,
    Claude,
    Hermes,
    OpenCode,
}

impl AgentRuntime {
    pub(super) fn from_agent_type(agent_type: Option<&str>) -> Self {
        match agent_type
            .unwrap_or("flowix")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "codex" => Self::Codex,
            "claude" => Self::Claude,
            "hermes" => Self::Hermes,
            "opencode" => Self::OpenCode,
            _ => Self::Flowix,
        }
    }

    pub(super) fn from_message(message: &AgentUserMessage) -> Self {
        Self::from_agent_type(message.agent_type.as_deref())
    }

    pub(super) fn key(self) -> &'static str {
        match self {
            Self::Flowix => "flowix",
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Hermes => "hermes",
            Self::OpenCode => "opencode",
        }
    }
}

pub(super) enum RuntimeHandle<'a> {
    Flowix(&'a Arc<AgentManager>),
    External(&'a dyn ExternalCliRuntime),
}

#[async_trait]
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

#[async_trait]
impl ChatRuntime for RuntimeHandle<'_> {
    async fn chat_stream(
        &self,
        thread_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<String, String> {
        match self {
            Self::Flowix(manager) => manager
                .chat_stream(thread_id, message, app_handle)
                .await
                .map_err(|e| e.to_string()),
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
            // Flowix 鍐呴儴 agent 鑷甫 cancel token + select!, stop 淇″彿鑳借娴佸紡
            // 任务即时响应, 不需要这里补�?StreamEnd, 故不�?app_handle�?
            Self::Flowix(manager) => manager.stop_chat(thread_id, run_id).await,
            Self::External(runtime) => runtime.stop_chat(thread_id, run_id, app_handle).await,
        }
    }
}

pub(super) fn runtime_handle<'a>(state: &'a AppState, runtime: AgentRuntime) -> RuntimeHandle<'a> {
    match runtime {
        AgentRuntime::Flowix => RuntimeHandle::Flowix(&state.agent_manager),
        external => RuntimeHandle::External(
            state
                .external_runtimes
                .get(external.key())
                .expect("every external AgentRuntime must be registered"),
        ),
    }
}

pub(super) async fn stop_any_runtime_chat(
    thread_id: &str,
    state: &AppState,
    app_handle: &tauri::AppHandle,
) -> bool {
    let (flowix, external) = tokio::join!(
        state.agent_manager.stop_chat(thread_id, None),
        state.external_runtimes.stop_chat_all(thread_id, app_handle),
    );
    flowix || external
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
            agent_role_memo_id: None,
            agent_role_name: None,
            conversation_title: None,
        }
    }

    #[test]
    fn agent_runtime_defaults_to_flowix() {
        assert_eq!(
            AgentRuntime::from_message(&message_with_agent_type(None)),
            AgentRuntime::Flowix
        );
        assert_eq!(
            AgentRuntime::from_message(&message_with_agent_type(Some(""))),
            AgentRuntime::Flowix
        );
    }

    #[test]
    fn agent_runtime_normalizes_known_agent_types() {
        let cases = [
            ("flowix", AgentRuntime::Flowix),
            (" CODEX ", AgentRuntime::Codex),
            ("Claude", AgentRuntime::Claude),
            ("HERMES", AgentRuntime::Hermes),
            ("opencode", AgentRuntime::OpenCode),
        ];

        for (agent_type, expected) in cases {
            assert_eq!(
                AgentRuntime::from_message(&message_with_agent_type(Some(agent_type))),
                expected,
                "agent_type {agent_type:?} should map to {expected:?}"
            );
        }
    }

    #[test]
    fn agent_runtime_unknown_values_fall_back_to_flowix() {
        assert_eq!(
            AgentRuntime::from_message(&message_with_agent_type(Some("unknown-agent"))),
            AgentRuntime::Flowix
        );
    }
}
