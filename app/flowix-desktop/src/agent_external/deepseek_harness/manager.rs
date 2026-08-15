use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tokio::sync::Mutex;

use super::host::DshHostClient;
use super::protocol::{self, AdaptedEvent, ThinkingSegment};
use super::AGENT_TYPE;
use crate::agent_external::lifecycle::ExternalLifecycleEmitter;
use crate::agent_external::{
    append_workspace_context, emit_chunk_with_run_id, emit_chunk_with_run_id_and_metadata,
    persist_external_chunk_for_thread_with_metadata, resolve_and_freeze_runtime_cwd,
    AgentChunkMetadata, StreamingEmitBuffer, STREAM_FLUSH_INTERVAL, USER_STOPPED_REASON,
};
use crate::agent_flowix::{AgentChunk, AgentUserMessage, RunInfo};
use crate::agent_session::ThreadManager;
use crate::config::{AiModelConfig, UserConfigStore};

struct ActiveRun {
    started_at: i64,
    last_event_at: i64,
    run_id: String,
    session_id: String,
    stream_end_emitted: Arc<AtomicBool>,
}

/// The provider configuration for one Harness host. The secret stays in the
/// host process environment and is never sent through the JSON-RPC protocol.
#[derive(Clone, PartialEq, Eq)]
pub struct HarnessRuntimeConfig {
    pub(crate) provider: String,
    pub(crate) provider_name: String,
    pub(crate) api_protocol: String,
    pub(crate) base_url: String,
    pub(crate) model: String,
    pub(crate) api_key: Option<String>,
}

/// Resolve the current Flowix model configuration into the stable Harness
/// route. Harness remains a separate agent runtime; Flowix only supplies the
/// selected provider connection and model.
pub fn resolve_runtime_config(
    config: &AiModelConfig,
    runtime_model: Option<&str>,
) -> Result<HarnessRuntimeConfig, String> {
    let provider_name = config.provider.trim();
    if provider_name.is_empty() {
        return Err("AI provider is not configured".to_string());
    }
    let model = runtime_model
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("inherit"))
        .or_else(|| {
            Some(config.model.trim())
                .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("inherit"))
        })
        .ok_or("AI model is not configured")?;

    let normalized = normalize_provider(provider_name);
    let (api_protocol, default_base_url, requires_api_key) = match normalized.as_str() {
        "anthropic" | "claude" => (
            "anthropic-messages",
            Some("https://api.anthropic.com/v1"),
            true,
        ),
        "openai" | "openairesponses" | "openairesponsesapi" | "responsesapi" => {
            ("openai-responses", Some("https://api.openai.com/v1"), true)
        }
        "deepseek" => (
            "openai-completions",
            Some("https://api.deepseek.com/v1"),
            true,
        ),
        "openrouter" => (
            "openai-completions",
            Some("https://openrouter.ai/api/v1"),
            true,
        ),
        "ollama" => (
            "openai-completions",
            Some("http://127.0.0.1:11434/v1"),
            false,
        ),
        "google" | "gemini" => {
            return Err(
                "DeepSeek Harness does not yet support Google/Gemini in the Flowix route"
                    .to_string(),
            )
        }
        _ => ("openai-completions", None, true),
    };
    let base_url = config
        .api_url
        .trim()
        .is_empty()
        .then_some(default_base_url)
        .flatten()
        .unwrap_or(config.api_url.trim())
        .trim_end_matches('/')
        .to_string();
    if base_url.is_empty() {
        return Err(format!(
            "API URL is not configured for provider {provider_name}"
        ));
    }

    let api_key = config.effective_api_key(provider_name).trim().to_string();
    if requires_api_key && api_key.is_empty() {
        return Err(format!(
            "API key is not configured for provider {provider_name}"
        ));
    }

    Ok(HarnessRuntimeConfig {
        provider: "flowix".to_string(),
        provider_name: provider_name.to_string(),
        api_protocol: api_protocol.to_string(),
        base_url,
        model: model.to_string(),
        api_key: (!api_key.is_empty()).then_some(api_key),
    })
}

fn normalize_provider(provider: &str) -> String {
    provider
        .chars()
        .filter(|character| !character.is_whitespace() && *character != '-' && *character != '_')
        .flat_map(char::to_lowercase)
        .collect()
}

pub struct DeepSeekHarnessManager {
    thread_manager: Arc<ThreadManager>,
    user_config: Arc<UserConfigStore>,
    session_root: PathBuf,
    host: Mutex<Option<Arc<DshHostClient>>>,
    host_api_key: Mutex<Option<String>>,
    active: Mutex<HashMap<String, ActiveRun>>,
}

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
            thread_manager,
            user_config,
            session_root,
            host: Mutex::new(None),
            host_api_key: Mutex::new(None),
            active: Mutex::new(HashMap::new()),
        }
    }

    pub async fn chat_stream(
        self: &Arc<Self>,
        thread_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<String, String> {
        let thread_id = thread_id.to_string();
        let run_id = crate::agent_external::resolve_run_id(&thread_id, message.run_id.as_deref());
        let session_id = self
            .thread_manager
            .get_external_session(&thread_id, AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?
            .unwrap_or_else(|| stable_session_id(&thread_id));
        let stream_end_emitted = Arc::new(AtomicBool::new(false));
        {
            let mut active = self.active.lock().await;
            if active.contains_key(&thread_id) {
                return Err("DeepSeek Harness is already running for this thread".to_string());
            }
            let now = chrono::Utc::now().timestamp_millis();
            active.insert(
                thread_id.clone(),
                ActiveRun {
                    started_at: now,
                    last_event_at: now,
                    run_id: run_id.clone(),
                    session_id: session_id.clone(),
                    stream_end_emitted: stream_end_emitted.clone(),
                },
            );
        }

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
                .run(&thread_id, &run_id, &session_id, &message, &app_handle)
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
            manager.remove_active_if_run(&thread_id, &run_id).await;
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
        session_id: &str,
        message: &AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<Option<String>, String> {
        let cwd = resolve_and_freeze_runtime_cwd(
            &self.thread_manager,
            thread_id,
            |message, _| message.cwd_for_runtime(AGENT_TYPE).map(PathBuf::from),
            message,
            Some(session_id),
            None,
        )
        .await?;
        let configured = self.user_config.get_ai_config().model;
        let runtime_config =
            resolve_runtime_config(&configured, message.model_for_runtime(AGENT_TYPE))?;
        let agent_preset = normalize_agent_preset(message.mode_for_runtime(AGENT_TYPE));
        let permission = normalize_permission(message.permission_mode_for_runtime(AGENT_TYPE));
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
            &runtime_config.base_url,
            &runtime_config.model,
            agent_preset,
            permission,
        );
        host.request_value(ensure).await?;
        self.thread_manager
            .upsert_external_session(thread_id, AGENT_TYPE, session_id, None)
            .await
            .map_err(|error| error.to_string())?;
        let mut events = host.subscribe(thread_id, run_id).await;
        let prompt_text = message.llm_content.as_deref().unwrap_or(&message.content);
        let prompt = append_workspace_context(prompt_text, &cwd, &workspace_paths);
        let start = protocol::run_start_request(host.next_request_id(), thread_id, run_id, &prompt);
        if let Err(error) = host.request_value(start).await {
            host.unsubscribe(thread_id, run_id).await;
            return Err(error);
        }

        let mut buffer = StreamingEmitBuffer::new(thread_id.to_string());
        let mut thinking_parser = protocol::ThinkingTagParser::new();
        // A single Harness run may contain multiple assistant segments:
        // assistant text -> tool -> assistant text.  The shared stream
        // materializer merges chunks with the same message id, so advance
        // this identity at every tool boundary.
        let mut assistant_segment = 0u64;
        let mut flush = tokio::time::interval(STREAM_FLUSH_INTERVAL);
        flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let terminal_reason = loop {
            tokio::select! {
                maybe = events.recv() => {
                    let Some(value) = maybe else { break Some("runtime_crashed".to_string()) };
                    self.touch(thread_id, run_id).await;
                    match protocol::adapt_event(&value, thread_id) {
                        AdaptedEvent::Chunk(AgentChunk::Text { text, .. }) => {
                            append_thinking_segments(
                                &mut buffer,
                                thinking_parser.push(&text),
                                assistant_segment,
                            );
                        }
                        AdaptedEvent::Chunk(AgentChunk::Reasoning { text, .. }) => {
                            append_thinking_segments(
                                &mut buffer,
                                vec![ThinkingSegment::Reasoning(text)],
                                assistant_segment,
                            );
                        }
                        AdaptedEvent::Chunk(chunk) => {
                            append_thinking_segments(
                                &mut buffer,
                                thinking_parser.flush_pending(),
                                assistant_segment,
                            );
                            self.flush_buffer(&mut buffer, app_handle, run_id).await;
                            if matches!(chunk, AgentChunk::ToolCall { .. }) {
                                assistant_segment = assistant_segment.saturating_add(1);
                            }
                            self.emit_and_persist_lifecycle_chunk(app_handle, &chunk, run_id).await;
                        }
                        AdaptedEvent::Completed(reason) => {
                            append_thinking_segments(
                                &mut buffer,
                                thinking_parser.finish(),
                                assistant_segment,
                            );
                            break reason;
                        }
                        AdaptedEvent::Ignore => {}
                    }
                }
                _ = flush.tick(), if !buffer.is_empty() => {
                    self.flush_buffer(&mut buffer, app_handle, run_id).await;
                }
            }
        };
        append_thinking_segments(&mut buffer, thinking_parser.finish(), assistant_segment);
        self.flush_buffer(&mut buffer, app_handle, run_id).await;
        host.unsubscribe(thread_id, run_id).await;
        Ok(terminal_reason.filter(|reason| reason != "completed"))
    }

    async fn flush_buffer(
        &self,
        buffer: &mut StreamingEmitBuffer,
        app: &tauri::AppHandle,
        run_id: &str,
    ) {
        // DSH assigns a new source message id after every tool boundary.  Do
        // not use the generic lifecycle path here: it intentionally supplies
        // default metadata and would collapse every assistant segment in the
        // run back to `assistant:stream` in both the live IPC payload and the
        // persisted event log.
        for (chunk, metadata) in buffer.flush_with_metadata() {
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

    async fn ensure_host(
        &self,
        runtime_config: &HarnessRuntimeConfig,
    ) -> Result<Arc<DshHostClient>, String> {
        let mut guard = self.host.lock().await;
        if let Some(host) = guard.as_ref().filter(|host| !host.is_closed()) {
            if *self.host_api_key.lock().await == runtime_config.api_key {
                return Ok(host.clone());
            }
            if self.active.lock().await.len() > 1 {
                return Err(
                    "DeepSeek Harness credentials changed while another run is active".to_string(),
                );
            }
            host.shutdown().await;
        }
        *guard = None;
        std::fs::create_dir_all(&self.session_root)
            .map_err(|error| format!("failed to create DSH session root: {error}"))?;
        let host =
            DshHostClient::spawn(runtime_config.api_key.as_deref(), &self.session_root).await?;
        *guard = Some(host.clone());
        *self.host_api_key.lock().await = runtime_config.api_key.clone();
        Ok(host)
    }

    pub async fn stop_chat(
        &self,
        thread_id: &str,
        run_id: Option<&str>,
        app: &tauri::AppHandle,
    ) -> bool {
        let target = {
            let active = self.active.lock().await;
            active.get(thread_id).and_then(|run| {
                (run_id.is_none() || run_id == Some(run.run_id.as_str()))
                    .then(|| (run.run_id.clone(), run.stream_end_emitted.clone()))
            })
        };
        let Some((run_id, stream_end_emitted)) = target else {
            return false;
        };
        if let Some(host) = self.host.lock().await.as_ref().cloned() {
            let request = protocol::run_cancel_request(host.next_request_id(), thread_id, &run_id);
            let _ = host.request_value(request).await;
        }
        self.remove_active_if_run(thread_id, &run_id).await;
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
        self.active
            .lock()
            .await
            .iter()
            .map(|(thread_id, run)| {
                (
                    thread_id.clone(),
                    RunInfo::active(
                        run.started_at,
                        Some("DeepSeek Harness"),
                        Some(AGENT_TYPE),
                        Some(run.run_id.clone()),
                        Some(thread_id.clone()),
                        Some(run.session_id.clone()),
                    ),
                )
            })
            .collect()
    }

    pub async fn stop_all(&self) -> usize {
        let count = self.active.lock().await.len();
        self.active.lock().await.clear();
        if let Some(host) = self.host.lock().await.take() {
            host.shutdown().await
        }
        *self.host_api_key.lock().await = None;
        count
    }

    pub async fn reap_inactive_runs(&self, app: &tauri::AppHandle, idle_timeout_ms: i64) -> usize {
        let now = chrono::Utc::now().timestamp_millis();
        let stale = self
            .active
            .lock()
            .await
            .iter()
            .filter(|(_, run)| now.saturating_sub(run.last_event_at) > idle_timeout_ms)
            .map(|(thread_id, run)| (thread_id.clone(), run.run_id.clone()))
            .collect::<Vec<_>>();
        let mut stopped = 0;
        for (thread_id, run_id) in stale {
            if self.stop_chat(&thread_id, Some(&run_id), app).await {
                stopped += 1
            }
        }
        stopped
    }

    async fn touch(&self, thread_id: &str, run_id: &str) {
        if let Some(active) = self.active.lock().await.get_mut(thread_id) {
            if active.run_id == run_id {
                active.last_event_at = chrono::Utc::now().timestamp_millis()
            }
        }
    }

    async fn remove_active_if_run(&self, thread_id: &str, run_id: &str) {
        let mut active = self.active.lock().await;
        if active
            .get(thread_id)
            .is_some_and(|run| run.run_id == run_id)
        {
            active.remove(thread_id);
        }
    }
}

fn append_thinking_segments(
    buffer: &mut StreamingEmitBuffer,
    segments: Vec<ThinkingSegment>,
    assistant_segment: u64,
) {
    let source_message_id = format!("assistant-stream-{assistant_segment}");
    for segment in segments {
        match segment {
            ThinkingSegment::Text(text) => buffer.append_text_with_metadata(
                &text,
                AgentChunkMetadata {
                    source_message_id: Some(source_message_id.clone()),
                    ..AgentChunkMetadata::default()
                },
            ),
            ThinkingSegment::Reasoning(text) => buffer.append_reasoning_with_metadata(
                &text,
                AgentChunkMetadata {
                    source_message_id: Some(source_message_id.clone()),
                    ..AgentChunkMetadata::default()
                },
            ),
        }
    }
}

fn normalize_permission(value: Option<&str>) -> &'static str {
    match value.map(str::trim) {
        Some("danger-full-access" | "yolo") => "danger-full-access",
        Some("workspace-write") => "workspace-write",
        _ => "read-only",
    }
}

fn normalize_agent_preset(value: Option<&str>) -> &'static str {
    match value.map(str::trim) {
        Some("code") => "code",
        Some("minimal") => "minimal",
        Some("cordis") => "cordis",
        _ => "standard",
    }
}

fn stable_session_id(thread_id: &str) -> String {
    let safe = thread_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    format!("flowix-{safe}")
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn agent_presets_default_to_standard_and_reject_unknown_values() {
        assert_eq!(normalize_agent_preset(None), "standard");
        assert_eq!(normalize_agent_preset(Some("standard")), "standard");
        assert_eq!(normalize_agent_preset(Some("code")), "code");
        assert_eq!(normalize_agent_preset(Some("minimal")), "minimal");
        assert_eq!(normalize_agent_preset(Some("cordis")), "cordis");
        assert_eq!(normalize_agent_preset(Some("unknown")), "standard");
    }

    #[test]
    fn session_ids_are_path_safe_and_stable() {
        assert_eq!(stable_session_id("thread/a b"), "flowix-thread_a_b");
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
            model: "MiniMax-M3".to_string(),
            api_url: "https://api.minimaxi.com/v1/".to_string(),
            api_keys: std::collections::HashMap::from([(
                "MiniMax Coding Plan".to_string(),
                "secret".to_string(),
            )]),
            max_total_tokens: 180_000,
        };
        let resolved = resolve_runtime_config(&config, None).unwrap();
        assert_eq!(resolved.provider, "flowix");
        assert_eq!(resolved.provider_name, "MiniMax Coding Plan");
        assert_eq!(resolved.api_protocol, "openai-completions");
        assert_eq!(resolved.model, "MiniMax-M3");
        assert_eq!(resolved.base_url, "https://api.minimaxi.com/v1");
        assert_eq!(resolved.api_key.as_deref(), Some("secret"));
    }

    #[test]
    fn runtime_model_override_is_supported_for_any_provider() {
        let config = AiModelConfig {
            provider: "DeepSeek".to_string(),
            model: "deepseek-v4-flash".to_string(),
            api_url: String::new(),
            api_keys: std::collections::HashMap::from([(
                "DeepSeek".to_string(),
                "secret".to_string(),
            )]),
            max_total_tokens: 180_000,
        };
        let resolved = resolve_runtime_config(&config, Some("deepseek-v4-pro")).unwrap();
        assert_eq!(resolved.model, "deepseek-v4-pro");
        assert_eq!(resolved.base_url, "https://api.deepseek.com/v1");
    }

    #[test]
    fn missing_active_provider_key_is_not_replaced_by_another_provider_key() {
        let config = AiModelConfig {
            provider: "MiniMax".to_string(),
            model: "MiniMax-M3".to_string(),
            api_url: "https://example.test/v1".to_string(),
            api_keys: std::collections::HashMap::from([(
                "DeepSeek".to_string(),
                "secret".to_string(),
            )]),
            max_total_tokens: 180_000,
        };
        let error = resolve_runtime_config(&config, None)
            .err()
            .expect("missing active provider key should fail");
        assert!(error.contains("MiniMax"));
    }
}
