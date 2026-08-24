use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::config::{
    normalize_agent_preset, normalize_permission, resolve_runtime_config, select_harness_config,
    HarnessRuntimeConfig,
};
use super::discovery::{cleanup_probe_host, create_probe_settings_file, timed_host_request};
use super::error::{harness_probe_failure, resolved_session_id};
use super::event_adapter::append_thinking_segments;
use super::host::{sync_credential_file, DshHostClient};
use super::host_registry::{HostLaunchSpec, HostRegistry, ProcessDshClientFactory};
use super::protocol::{self, AdaptedEvent};
use super::run_coordinator::RunCoordinator;
use super::run_projector::{Projection, RunEventProjector};
use super::session_registry::SessionRegistry;
use super::transport::DshClient;
use super::AGENT_TYPE;
use crate::agent_external::lifecycle::ExternalLifecycleEmitter;
use crate::agent_external::{
    append_workspace_context, emit_chunk_with_run_id, emit_chunk_with_run_id_and_metadata,
    persist_external_chunk_for_thread_with_metadata, AgentChunkMetadata, StreamingEmitBuffer,
    STREAM_FLUSH_INTERVAL, USER_STOPPED_REASON,
};
use crate::agent_session::{ChatMessage, ThreadManager, ThreadMessagesPage};
use crate::agent_wire::{AgentChunk, AgentUserMessage, RunInfo};
use crate::config::{AiModelConfig, UserConfigStore};
use crate::connection_probe::{TestConnectionErrorKind, TestConnectionResult};

#[derive(Clone, Debug, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepSeekHarnessSessionUsage {
    pub session_id: String,
    pub model_id: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub context_tokens: Option<u64>,
    pub context_window: Option<u64>,
}

pub struct DeepSeekHarnessManager {
    pub(crate) thread_manager: Arc<ThreadManager>,
    sessions: SessionRegistry,
    pub(crate) user_config: Arc<UserConfigStore>,
    pub(crate) session_root: PathBuf,
    /// Harness child processes are keyed by credential. One process cannot
    /// safely serve two different API keys because the key is injected through
    /// its environment, but different keys can be used concurrently.
    pub(crate) hosts: HostRegistry,
    pub(crate) runs: RunCoordinator,
}

pub(crate) const HARNESS_PROBE_TIMEOUT: Duration = Duration::from_secs(30);

#[async_trait::async_trait]
impl ExternalLifecycleEmitter for DeepSeekHarnessManager {
    fn lifecycle_agent_type(&self) -> &'static str {
        AGENT_TYPE
    }

    async fn emit_and_persist_lifecycle_chunk(
        &self,
        app_handle: &tauri::AppHandle,
        chunk: &AgentChunk,
        run_id: &str,
    ) {
        persist_external_chunk_for_thread_with_metadata(
            &self.thread_manager,
            AGENT_TYPE,
            chunk.thread_id(),
            chunk,
            run_id,
            None,
            &AgentChunkMetadata::default(),
        )
        .await;
        emit_chunk_with_run_id(app_handle, chunk, AGENT_TYPE, run_id);
    }

    async fn persist_emitted_stream_end(&self, chunk: &AgentChunk, run_id: &str) {
        persist_external_chunk_for_thread_with_metadata(
            &self.thread_manager,
            AGENT_TYPE,
            chunk.thread_id(),
            chunk,
            run_id,
            None,
            &AgentChunkMetadata::default(),
        )
        .await;
    }
}

impl DeepSeekHarnessManager {
    pub fn new(
        thread_manager: Arc<ThreadManager>,
        user_config: Arc<UserConfigStore>,
        session_root: PathBuf,
    ) -> Self {
        Self {
            sessions: SessionRegistry::new(thread_manager.clone(), AGENT_TYPE),
            thread_manager,
            user_config,
            session_root,
            hosts: HostRegistry::new(Arc::new(ProcessDshClientFactory)),
            runs: RunCoordinator::default(),
        }
    }

    pub async fn chat_stream(
        self: &Arc<Self>,
        thread_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<String, String> {
        if !crate::dsh::status().installed {
            return Err("DeepSeek Harness runtime is not installed".to_string());
        }

        let thread_id = thread_id.to_string();
        let run_id = crate::agent_external::resolve_run_id(&thread_id, message.run_id.as_deref());
        let session_id = self.sessions.session_id(&thread_id).await?;
        let stream_end_emitted = Arc::new(AtomicBool::new(false));
        self.runs
            .register(
                &thread_id,
                &run_id,
                session_id.as_deref(),
                stream_end_emitted.clone(),
            )
            .await?;

        let manager = self.clone();
        let app_handle = app_handle.clone();
        tokio::spawn(async move {
            manager
                .emit_user_message(&app_handle, &thread_id, &message, &run_id)
                .await;
            manager
                .emit_stream_start(&app_handle, &thread_id, &message, &run_id)
                .await;
            let result = manager
                .run(
                    &thread_id,
                    &run_id,
                    session_id.as_deref(),
                    &message,
                    &app_handle,
                )
                .await;
            let reason = match result {
                Ok(reason) => reason,
                Err(error) => {
                    manager
                        .emit_run_error(&app_handle, &thread_id, error.clone(), &run_id)
                        .await;
                    Some(error)
                }
            };
            manager.runs.remove_if_matches(&thread_id, &run_id).await;
            manager
                .emit_stream_end(
                    &app_handle,
                    &thread_id,
                    &run_id,
                    reason,
                    &stream_end_emitted,
                )
                .await;
        });
        Ok(String::new())
    }

    async fn run(
        &self,
        thread_id: &str,
        run_id: &str,
        session_id: Option<&str>,
        message: &AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<Option<String>, String> {
        // Harness owns a restartable runtime generation, so a conversation may
        // adopt a new cwd between runs while preserving its session id. Prefer
        // the requested cwd; the persisted value is only a recovery fallback.
        // Commit it after runtime.ensure succeeds so failed transitions keep
        // the last known-good workspace.
        let requested_cwd = message.cwd_for_runtime(AGENT_TYPE).map(PathBuf::from);
        let cwd = self.sessions.resolve_cwd(thread_id, requested_cwd).await?;
        let configured = select_harness_config(
            self.user_config
                .get_deepseek_harness_configs()
                .map_err(|error| error.to_string())?,
            message.provider_id_for_runtime(AGENT_TYPE),
        )?;
        let runtime_config =
            resolve_runtime_config(&configured, message.model_for_runtime(AGENT_TYPE))?;
        let agent_preset = normalize_agent_preset(message.mode_for_runtime(AGENT_TYPE));
        let permission = normalize_permission(message.permission_mode_for_runtime(AGENT_TYPE));
        self.runs
            .bind_host(thread_id, run_id, runtime_config.host_key())
            .await;
        let host = self.ensure_host(&runtime_config).await?;
        let workspace_paths = message.workspace_paths_for_runtime(AGENT_TYPE);
        let ensure = protocol::runtime_ensure_request(
            host.next_request_id(),
            thread_id,
            session_id,
            &cwd.to_string_lossy(),
            &workspace_paths,
            &runtime_config.provider,
            &runtime_config.provider_name,
            &runtime_config.api_protocol,
            &runtime_config.api_key_env,
            &runtime_config.base_url,
            &runtime_config.model,
            agent_preset,
            permission,
        );
        let session_id = resolved_session_id(host.request(ensure).await?)?;
        self.runs.bind_session(thread_id, run_id, &session_id).await;
        self.sessions.commit(thread_id, &session_id, &cwd).await?;
        let mut events = host.subscribe(thread_id, run_id).await;
        let prompt_text = message.llm_content.as_deref().unwrap_or(&message.content);
        let prompt = append_workspace_context(prompt_text, &cwd, &workspace_paths);
        let client_message_id = format!("flowix:{thread_id}:{run_id}");
        let start = protocol::run_start_request(
            host.next_request_id(),
            thread_id,
            run_id,
            &prompt,
            &message.content,
            &client_message_id,
        );
        if let Err(error) = host.request(start).await {
            host.unsubscribe(thread_id, run_id).await;
            return Err(error);
        }

        let mut projector = RunEventProjector::new(thread_id.to_string());
        let mut flush = tokio::time::interval(STREAM_FLUSH_INTERVAL);
        flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let terminal_reason = loop {
            tokio::select! {
                maybe = events.recv() => {
                    let Some(value) = maybe else { break Some("runtime_crashed".to_string()) };
                    self.runs.touch(thread_id, run_id).await;
                    match projector.accept(protocol::adapt_event(&value, thread_id)) {
                        Projection::Buffered => {}
                        Projection::Boundary { buffered, chunk } => {
                            self.emit_buffered(buffered, app_handle, run_id).await;
                            self.emit_and_persist_lifecycle_chunk(app_handle, &chunk, run_id).await;
                        }
                        Projection::Completed { buffered, reason } => {
                            self.emit_buffered(buffered, app_handle, run_id).await;
                            break reason;
                        }
                    }
                }
                _ = flush.tick(), if !projector.is_empty() => {
                    let buffered = projector.flush();
                    self.emit_buffered(buffered, app_handle, run_id).await;
                }
            }
        };
        let buffered = projector.finish();
        self.emit_buffered(buffered, app_handle, run_id).await;
        host.unsubscribe(thread_id, run_id).await;
        Ok(terminal_reason.filter(|reason| reason != "completed"))
    }

    async fn emit_buffered(
        &self,
        buffered: Vec<(AgentChunk, AgentChunkMetadata)>,
        app: &tauri::AppHandle,
        run_id: &str,
    ) {
        // DSH assigns a new source message id after every tool boundary.  Do
        // not use the generic lifecycle path here: it intentionally supplies
        // default metadata and would collapse every assistant segment in the
        // run back to `assistant:stream` in both the live IPC payload and the
        // persisted event log.
        for (chunk, metadata) in buffered {
            persist_external_chunk_for_thread_with_metadata(
                &self.thread_manager,
                AGENT_TYPE,
                chunk.thread_id(),
                &chunk,
                run_id,
                None,
                &metadata,
            )
            .await;
            emit_chunk_with_run_id_and_metadata(app, &chunk, AGENT_TYPE, run_id, &metadata);
        }
    }

    pub(crate) async fn ensure_host(
        &self,
        runtime_config: &HarnessRuntimeConfig,
    ) -> Result<Arc<dyn DshClient>, String> {
        let host_key = runtime_config.host_key();
        let credential = runtime_config
            .api_key
            .as_deref()
            .map(|secret| (runtime_config.api_key_env.as_str(), secret));
        self.hosts
            .ensure(&host_key, &self.host_launch_spec(), credential)
            .await
    }

    pub(crate) async fn model_host(&self) -> Result<(Arc<dyn DshClient>, bool), String> {
        self.hosts
            .existing_or_ephemeral(&self.host_launch_spec())
            .await
    }

    fn host_launch_spec(&self) -> HostLaunchSpec {
        let dsh_home = self.user_config.dsh_dir();
        HostLaunchSpec {
            session_root: self.session_root.clone(),
            settings_path: self.user_config.dsh_settings_path(),
            credentials_path: dsh_home.join(".credentials.yaml"),
            plugin_settings_path: self.plugin_settings_path(),
            dsh_home,
        }
    }

    pub(crate) fn plugin_settings_path(&self) -> PathBuf {
        self.user_config.dsh_plugin_settings_path()
    }

    /// Read durable DSH history through the host bridge. DSH owns this event
    /// log; Flowix only adapts the page into its IPC shape.
    pub async fn session_history_page(
        &self,
        thread_id: &str,
        before_sequence: Option<i64>,
        snapshot_sequence: Option<i64>,
        limit: i64,
    ) -> Result<ThreadMessagesPage, String> {
        let session_id = self
            .sessions
            .session_id(thread_id)
            .await?
            .ok_or_else(|| format!("no DeepSeek Harness session for thread {thread_id}"))?;
        let (host, ephemeral) = self
            .hosts
            .existing_or_ephemeral(&self.host_launch_spec())
            .await?;
        let result = host
            .request(protocol::session_history_request(
                host.next_request_id(),
                &session_id,
                before_sequence,
                snapshot_sequence,
                limit,
            ))
            .await;
        if ephemeral {
            host.shutdown().await;
        }
        let page: DshSessionHistoryPage = result.and_then(|value| {
            serde_json::from_value(value)
                .map_err(|error| format!("invalid DSH session history response: {error}"))
        })?;
        Ok(ThreadMessagesPage {
            messages: page.messages,
            oldest_sequence: page.oldest_sequence,
            has_more: page.has_more,
            snapshot_sequence: Some(page.snapshot_sequence),
        })
    }

    pub async fn stop_chat(
        &self,
        thread_id: &str,
        run_id: Option<&str>,
        app: &tauri::AppHandle,
    ) -> bool {
        let Some(target) = self.runs.target(thread_id, run_id).await else {
            return false;
        };
        let run_id = target.run_id;
        let stream_end_emitted = target.stream_end_emitted;
        let hosts = self
            .hosts
            .cancellation_targets(target.host_key.as_deref())
            .await;
        for host in hosts {
            let request = protocol::run_cancel_request(host.next_request_id(), thread_id, &run_id);
            let _ = host.request(request).await;
        }
        self.runs.remove_if_matches(thread_id, &run_id).await;
        self.emit_stream_end(
            app,
            thread_id,
            &run_id,
            Some(USER_STOPPED_REASON.to_string()),
            &stream_end_emitted,
        )
        .await;
        true
    }

    pub async fn running_threads(&self) -> HashMap<String, RunInfo> {
        self.runs.running_threads(AGENT_TYPE).await
    }

    pub async fn stop_all(&self) -> usize {
        let count = self.runs.clear().await;
        self.hosts.shutdown_all().await;
        count
    }

    pub async fn reap_inactive_runs(&self, app: &tauri::AppHandle, idle_timeout_ms: i64) -> usize {
        let stale = self.runs.stale_runs(idle_timeout_ms).await;
        let mut stopped = 0;
        for (thread_id, run_id) in stale {
            if self.stop_chat(&thread_id, Some(&run_id), app).await {
                stopped += 1
            }
        }
        stopped
    }

    /// Close all cached hosts before a provider, credential, or plugin
    /// configuration change. A live run must finish first: closing its host
    /// would terminate the runtime underneath an in-flight tool call.
    pub async fn invalidate_hosts(&self) -> Result<(), String> {
        if !self.runs.is_empty().await {
            return Err("DeepSeek Harness 配置运行中不可修改，请先停止当前任务".to_string());
        }
        self.hosts.shutdown_all().await;
        Ok(())
    }

    /// Check update eligibility without stopping idle hosts. The updater uses
    /// this before downloading, then calls `invalidate_hosts` immediately
    /// before publishing the verified staged runtime.
    pub async fn ensure_hosts_replaceable(&self) -> Result<(), String> {
        if !self.runs.is_empty().await {
            return Err(
                "DeepSeek Harness is running a task; stop it before replacing the runtime"
                    .to_string(),
            );
        }
        Ok(())
    }

    /// Shut down every dsh-host child before the managed runtime is
    /// uninstalled. Refuses while a Harness run is active: deleting the
    /// binary underneath a live session would strand the run without its
    /// final StreamEnd. `~/.dsh` user state is untouched by the caller.
    pub async fn prepare_uninstall(&self) -> Result<(), String> {
        if !self.runs.is_empty().await {
            return Err("DeepSeek Harness 正在运行任务，请先停止后再卸载".to_string());
        }
        self.hosts.shutdown_all().await;
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DshSessionHistoryPage {
    messages: Vec<ChatMessage>,
    oldest_sequence: Option<i64>,
    has_more: bool,
    snapshot_sequence: i64,
}

#[cfg(test)]
mod tests {
    use super::super::protocol::ThinkingSegment;
    use super::*;
    use crate::config::{AiConfigFile, AiModelEntry};

    #[test]
    fn permissions_fail_closed() {
        assert_eq!(normalize_permission(None), "read-only");
        assert_eq!(normalize_permission(Some("unknown")), "read-only");
        assert_eq!(
            normalize_permission(Some("workspace-write")),
            "workspace-write"
        );
    }

    #[test]
    fn host_cache_key_is_a_stable_non_secret_fingerprint() {
        let first = HarnessRuntimeConfig {
            provider: "openai".to_string(),
            provider_name: "GLM".to_string(),
            api_protocol: "openai-completions".to_string(),
            api_key_env: "FLOWIX_DSH_API_KEY".to_string(),
            base_url: "https://example.test/v1".to_string(),
            model: "glm".to_string(),
            api_key: Some("secret-a".to_string()),
        };
        let same = HarnessRuntimeConfig {
            api_key: Some("secret-a".to_string()),
            ..first.clone()
        };
        let other = HarnessRuntimeConfig {
            api_key: Some("secret-b".to_string()),
            ..first.clone()
        };

        assert_eq!(first.host_key(), same.host_key());
        assert_eq!(first.host_key(), other.host_key());
        assert!(!first.host_key().contains("secret-a"));
        assert_eq!(first.host_key(), "credential-ref:FLOWIX_DSH_API_KEY");
    }

    #[test]
    fn agent_presets_default_to_standard_and_reject_unknown_values() {
        assert_eq!(normalize_agent_preset(None), "standard");
        assert_eq!(normalize_agent_preset(Some("standard")), "standard");
        assert_eq!(normalize_agent_preset(Some("code")), "code");
        assert_eq!(normalize_agent_preset(Some("minimal")), "minimal");
        assert_eq!(normalize_agent_preset(Some("cordis")), "cordis");
        assert_eq!(normalize_agent_preset(Some("unknown")), "standard");
    }

    #[test]
    fn probe_settings_include_a_new_active_model_without_persisting_a_key() {
        let config = AiModelConfig {
            provider: "acme-gateway".to_string(),
            provider_id: "acme-gateway".to_string(),
            display_name: "Acme Gateway".to_string(),
            api_protocol: "openai-completions".to_string(),
            model: "model-b".to_string(),
            models: vec![AiModelEntry {
                id: "model-a".to_string(),
                name: "Model A".to_string(),
            }],
            api_url: "https://gateway.example/v1".to_string(),
            api_keys: std::collections::HashMap::from([(
                "acme-gateway".to_string(),
                "secret".to_string(),
            )]),
            ..AiModelConfig::default()
        };

        let path = create_probe_settings_file(&config).unwrap();
        let settings = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(path);
        assert!(settings.contains("id: model-a"), "got: {settings}");
        assert!(settings.contains("id: model-b"), "got: {settings}");
        assert!(
            !settings.contains("secret"),
            "probe settings leaked the API key"
        );
    }

    #[test]
    fn assistant_segments_use_distinct_message_ids_across_tool_boundaries() {
        let mut buffer = StreamingEmitBuffer::new("thread-1".to_string());
        append_thinking_segments(
            &mut buffer,
            vec![ThinkingSegment::Text("before".to_string())],
            0,
        );
        let first = buffer.flush_with_metadata();

        append_thinking_segments(
            &mut buffer,
            vec![ThinkingSegment::Text("after".to_string())],
            1,
        );
        let second = buffer.flush_with_metadata();

        assert_eq!(
            first[0].1.source_message_id.as_deref(),
            Some("assistant-stream-0")
        );
        assert_eq!(
            second[0].1.source_message_id.as_deref(),
            Some("assistant-stream-1")
        );
        let first_payload = crate::agent_external::shared::chunk_payload_value(
            &first[0].0,
            AGENT_TYPE,
            "run-1",
            &first[0].1,
        )
        .expect("first stream payload");
        let second_payload = crate::agent_external::shared::chunk_payload_value(
            &second[0].0,
            AGENT_TYPE,
            "run-1",
            &second[0].1,
        )
        .expect("second stream payload");
        assert_eq!(
            first_payload["message_id"],
            "msg:deepseek-harness:run-1:assistant:assistant-stream-0"
        );
        assert_eq!(
            second_payload["message_id"],
            "msg:deepseek-harness:run-1:assistant:assistant-stream-1"
        );
    }

    #[test]
    fn non_deepseek_provider_is_resolved_as_a_harness_agent_route() {
        let config = AiModelConfig {
            provider: "MiniMax Coding Plan".to_string(),
            provider_id: "minimax".to_string(),
            model: "MiniMax-M3".to_string(),
            api_url: "https://api.minimaxi.com/v1/".to_string(),
            api_keys: std::collections::HashMap::from([(
                "minimax".to_string(),
                "secret".to_string(),
            )]),
            max_total_tokens: 180_000,
            ..AiModelConfig::default()
        };
        let resolved = resolve_runtime_config(&config, None).unwrap();
        assert_eq!(resolved.provider, "minimax");
        assert_eq!(resolved.provider_name, "MiniMax Coding Plan");
        assert_eq!(resolved.api_protocol, "openai-completions");
        assert_eq!(resolved.model, "MiniMax-M3");
        assert_eq!(resolved.base_url, "https://api.minimaxi.com/v1");
        assert_eq!(resolved.api_key.as_deref(), Some("secret"));
    }

    #[test]
    fn display_name_does_not_replace_the_llm_pi_ai_route() {
        let config = AiModelConfig {
            provider: "OpenAI Chat Completions".to_string(),
            provider_id: "openai".to_string(),
            display_name: "OpenAI Chat Completions".to_string(),
            model: "deepseek-v4-flash".to_string(),
            api_url: "https://api.deepseek.com".to_string(),
            api_keys: std::collections::HashMap::from([(
                "openai".to_string(),
                "secret".to_string(),
            )]),
            max_total_tokens: 180_000,
            ..AiModelConfig::default()
        };

        let resolved = resolve_runtime_config(&config, None).unwrap();
        assert_eq!(resolved.provider, "openai");
        assert_eq!(resolved.provider_name, "OpenAI Chat Completions");
        assert_eq!(resolved.api_protocol, "openai-completions");
    }

    #[test]
    fn genuine_custom_route_is_not_redirected_to_flowix() {
        let config = AiModelConfig {
            provider: "acme-gateway".to_string(),
            provider_id: "acme-gateway".to_string(),
            display_name: "OpenAI Chat Completions".to_string(),
            model: "acme-large".to_string(),
            api_url: "https://gateway.acme.example/v1".to_string(),
            api_keys: std::collections::HashMap::from([(
                "acme-gateway".to_string(),
                "secret".to_string(),
            )]),
            max_total_tokens: 180_000,
            ..AiModelConfig::default()
        };

        let resolved = resolve_runtime_config(&config, None).unwrap();
        assert_eq!(resolved.provider, "acme-gateway");
    }

    #[test]
    fn runtime_model_override_is_supported_for_any_provider() {
        let config = AiModelConfig {
            provider: "DeepSeek".to_string(),
            provider_id: "deepseek".to_string(),
            model: "deepseek-v4-flash".to_string(),
            api_url: String::new(),
            api_keys: std::collections::HashMap::from([(
                "DeepSeek".to_string(),
                "secret".to_string(),
            )]),
            max_total_tokens: 180_000,
            ..AiModelConfig::default()
        };
        let resolved = resolve_runtime_config(&config, Some("deepseek-v4-pro")).unwrap();
        assert_eq!(resolved.model, "deepseek-v4-pro");
        assert_eq!(resolved.base_url, "https://api.deepseek.com/v1");
    }

    #[test]
    fn custom_provider_uses_its_route_protocol_and_credential_bucket() {
        let config = AiModelConfig {
            provider: "acme-gateway".to_string(),
            provider_id: "acme-gateway".to_string(),
            display_name: "Acme Gateway".to_string(),
            api_protocol: "anthropic-messages".to_string(),
            model: "acme-large".to_string(),
            api_url: "https://gateway.acme.example/v1".to_string(),
            api_keys: std::collections::HashMap::from([(
                "acme-gateway".to_string(),
                "secret".to_string(),
            )]),
            ..AiModelConfig::default()
        };

        let resolved = resolve_runtime_config(&config, None).unwrap();
        assert_eq!(resolved.provider, "acme-gateway");
        assert_eq!(resolved.provider_name, "Acme Gateway");
        assert_eq!(resolved.api_protocol, "anthropic-messages");
        assert_eq!(resolved.api_key.as_deref(), Some("secret"));
    }

    #[test]
    fn missing_active_provider_key_is_not_replaced_by_another_provider_key() {
        let config = AiModelConfig {
            provider: "MiniMax".to_string(),
            provider_id: "minimax".to_string(),
            model: "MiniMax-M3".to_string(),
            api_url: "https://example.test/v1".to_string(),
            api_keys: std::collections::HashMap::from([(
                "DeepSeek".to_string(),
                "secret".to_string(),
            )]),
            max_total_tokens: 180_000,
            ..AiModelConfig::default()
        };
        let resolved = resolve_runtime_config(&config, None).unwrap();
        assert_eq!(resolved.api_key, None);
        assert_eq!(resolved.api_key_env, "FLOWIX_DSH_MINIMAX_API_KEY");
    }

    fn route_config(route: &str, model: &str) -> AiConfigFile {
        AiConfigFile {
            model: AiModelConfig {
                provider: route.to_string(),
                provider_id: route.to_string(),
                model: model.to_string(),
                ..AiModelConfig::default()
            },
        }
    }

    #[test]
    fn selected_route_keeps_provider_boundaries_when_model_ids_overlap() {
        let configs = vec![
            route_config("provider-a", "same-model"),
            route_config("provider-b", "same-model"),
        ];

        let selected = select_harness_config(configs, Some("provider-b")).unwrap();
        assert_eq!(selected.provider_id, "provider-b");
    }

    #[test]
    fn selecting_unknown_route_fails_instead_of_falling_back() {
        let error =
            select_harness_config(vec![route_config("provider-a", "model")], Some("missing"))
                .expect_err("unknown provider routes must not silently use another key");
        assert!(error.contains("missing"));
    }

    #[test]
    fn obsolete_flowix_route_is_not_selected() {
        let legacy = AiConfigFile {
            model: AiModelConfig {
                provider: "DeepSeek".to_string(),
                provider_id: "flowix".to_string(),
                model: "deepseek-chat".to_string(),
                ..AiModelConfig::default()
            },
        };
        let selected = select_harness_config(vec![legacy], Some("flowix"));
        assert!(selected.is_ok());
        let error = match resolve_runtime_config(&selected.unwrap(), None) {
            Ok(_) => panic!("obsolete Flowix route must be rejected"),
            Err(error) => error,
        };
        assert!(error.contains("obsolete Flowix route"));
    }
}
