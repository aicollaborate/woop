//! Single registration point for every external CLI runtime.
//!
//! Runtime-specific managers keep their protocol implementations. This layer
//! only normalizes application-wide lifecycle operations so chat dispatch,
//! stop, watchdog reaping, shutdown, and running-thread aggregation cannot
//! drift into separate hard-coded runtime lists.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use futures::future::join_all;

use super::claude::{ClaudeCliManager, AGENT_TYPE as CLAUDE_AGENT_TYPE};
use super::codex::{CodexCliManager, AGENT_TYPE as CODEX_AGENT_TYPE};
use super::hermes::HermesCliManager;
use super::opencode::{OpenCodeAcpManager, AGENT_TYPE as OPENCODE_AGENT_TYPE};
use crate::agent_flowix::{AgentUserMessage, RunInfo};

const HERMES_AGENT_TYPE: &str = "hermes";

#[async_trait]
pub trait ExternalCliRuntime: Send + Sync {
    fn key(&self) -> &'static str;

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

    async fn running_threads(&self) -> HashMap<String, RunInfo>;
    async fn stop_all(&self) -> usize;

    async fn reap_inactive_runs(
        &self,
        app_handle: &tauri::AppHandle,
        idle_timeout_ms: i64,
    ) -> usize;
}

macro_rules! impl_external_runtime {
    ($manager:ty, $key:expr) => {
        #[async_trait]
        impl ExternalCliRuntime for Arc<$manager> {
            fn key(&self) -> &'static str {
                $key
            }

            async fn chat_stream(
                &self,
                thread_id: &str,
                message: AgentUserMessage,
                app_handle: &tauri::AppHandle,
            ) -> Result<String, String> {
                <$manager>::chat_stream(self, thread_id, message, app_handle).await
            }

            async fn stop_chat(
                &self,
                thread_id: &str,
                run_id: Option<&str>,
                app_handle: &tauri::AppHandle,
            ) -> bool {
                <$manager>::stop_chat(self.as_ref(), thread_id, run_id, app_handle).await
            }

            async fn running_threads(&self) -> HashMap<String, RunInfo> {
                <$manager>::running_threads(self.as_ref()).await
            }

            async fn stop_all(&self) -> usize {
                <$manager>::stop_all(self.as_ref()).await
            }

            async fn reap_inactive_runs(
                &self,
                app_handle: &tauri::AppHandle,
                idle_timeout_ms: i64,
            ) -> usize {
                <$manager>::reap_inactive_runs(self.as_ref(), app_handle, idle_timeout_ms).await
            }
        }
    };
}

impl_external_runtime!(CodexCliManager, CODEX_AGENT_TYPE);
impl_external_runtime!(ClaudeCliManager, CLAUDE_AGENT_TYPE);
impl_external_runtime!(HermesCliManager, HERMES_AGENT_TYPE);
impl_external_runtime!(OpenCodeAcpManager, OPENCODE_AGENT_TYPE);

pub struct ExternalRuntimeRegistry {
    runtimes: Vec<Box<dyn ExternalCliRuntime>>,
}

impl ExternalRuntimeRegistry {
    pub fn new(
        codex: Arc<CodexCliManager>,
        claude: Arc<ClaudeCliManager>,
        hermes: Arc<HermesCliManager>,
        opencode: Arc<OpenCodeAcpManager>,
    ) -> Self {
        let runtimes: Vec<Box<dyn ExternalCliRuntime>> = vec![
            Box::new(codex),
            Box::new(claude),
            Box::new(hermes),
            Box::new(opencode),
        ];
        debug_assert_eq!(
            runtimes
                .iter()
                .map(|runtime| runtime.key())
                .collect::<std::collections::HashSet<_>>()
                .len(),
            runtimes.len(),
            "external runtime keys must be unique"
        );
        Self { runtimes }
    }

    pub fn get(&self, key: &str) -> Option<&dyn ExternalCliRuntime> {
        self.runtimes
            .iter()
            .find(|runtime| runtime.key() == key)
            .map(Box::as_ref)
    }

    pub fn iter(&self) -> impl Iterator<Item = &dyn ExternalCliRuntime> {
        self.runtimes.iter().map(Box::as_ref)
    }

    pub async fn stop_chat_all(&self, thread_id: &str, app_handle: &tauri::AppHandle) -> bool {
        join_all(
            self.iter()
                .map(|runtime| runtime.stop_chat(thread_id, None, app_handle)),
        )
        .await
        .into_iter()
        .any(|stopped| stopped)
    }

    pub async fn running_threads(&self) -> HashMap<String, RunInfo> {
        let mut all = HashMap::new();
        for threads in join_all(self.iter().map(ExternalCliRuntime::running_threads)).await {
            all.extend(threads);
        }
        all
    }

    pub async fn reap_inactive_runs(
        &self,
        app_handle: &tauri::AppHandle,
        idle_timeout_ms: i64,
    ) -> Vec<(&'static str, usize)> {
        let counts = join_all(
            self.iter()
                .map(|runtime| runtime.reap_inactive_runs(app_handle, idle_timeout_ms)),
        )
        .await;
        self.iter()
            .map(ExternalCliRuntime::key)
            .zip(counts)
            .collect()
    }

    pub async fn stop_all(&self) -> Vec<(&'static str, usize)> {
        let counts = join_all(self.iter().map(ExternalCliRuntime::stop_all)).await;
        self.iter()
            .map(ExternalCliRuntime::key)
            .zip(counts)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_external_config::EXTERNAL_AGENT_KEYS;
    use crate::agent_session::ThreadManager;

    #[test]
    fn registry_contains_every_external_runtime_once() {
        let threads = ThreadManager::for_tests();
        let registry = ExternalRuntimeRegistry::new(
            Arc::new(CodexCliManager::new(threads.clone())),
            Arc::new(ClaudeCliManager::new(threads.clone())),
            Arc::new(HermesCliManager::new(threads.clone())),
            Arc::new(OpenCodeAcpManager::new(threads)),
        );

        let keys = registry
            .iter()
            .map(ExternalCliRuntime::key)
            .collect::<Vec<_>>();
        assert_eq!(keys, EXTERNAL_AGENT_KEYS);
        for key in &keys {
            assert_eq!(registry.get(key).map(ExternalCliRuntime::key), Some(*key));
        }
    }
}
