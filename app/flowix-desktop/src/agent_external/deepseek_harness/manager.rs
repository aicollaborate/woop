use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::Mutex;

use super::host::{sync_credential_file, DshHostClient};
use super::protocol::{self, AdaptedEvent, ThinkingSegment};
use super::AGENT_TYPE;
use crate::agent_external::lifecycle::ExternalLifecycleEmitter;
use crate::agent_external::{
    append_workspace_context, emit_chunk_with_run_id, emit_chunk_with_run_id_and_metadata,
    persist_external_chunk_for_thread_with_metadata, resolve_and_freeze_runtime_cwd,
    AgentChunkMetadata, StreamingEmitBuffer, STREAM_FLUSH_INTERVAL, USER_STOPPED_REASON,
};
use crate::agent_session::ThreadManager;
use crate::agent_wire::{AgentChunk, AgentUserMessage, RunInfo};
use crate::config::{
    dsh_credential_ref_for_route, AiConfigFile, AiModelConfig, AiModelEntry, UserConfigStore,
};
use crate::connection_probe::{TestConnectionError, TestConnectionErrorKind, TestConnectionResult};

struct ActiveRun {
    started_at: i64,
    last_event_at: i64,
    run_id: String,
    session_id: String,
    stream_end_emitted: Arc<AtomicBool>,
    /// Credential bucket of the host serving this run. Kept in memory only so
    /// idle hosts can be retired without putting secrets on disk or logs.
    host_key: Option<String>,
}

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

#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedRuntimeConfig {
    model: Option<PersistedModelConfig>,
    access: Option<PersistedAccessConfig>,
    deepseek_harness: Option<PersistedDeepSeekHarnessConfig>,
    cwd: Option<String>,
    workspace_snapshot: Option<PersistedWorkspaceSnapshot>,
}

#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedModelConfig {
    key: Option<String>,
    provider_id: Option<String>,
}

#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedAccessConfig {
    sandbox: Option<String>,
}

#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedDeepSeekHarnessConfig {
    mode: Option<String>,
}

#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedWorkspaceSnapshot {
    cwd: Option<String>,
    #[serde(default)]
    workspace_paths: Vec<String>,
}

/// The provider configuration for one Harness host. The secret stays in the
/// host process environment and is never sent through the JSON-RPC protocol.
#[derive(Clone, PartialEq, Eq)]
pub struct HarnessRuntimeConfig {
    pub(crate) provider: String,
    pub(crate) provider_name: String,
    pub(crate) api_protocol: String,
    pub(crate) api_key_env: String,
    pub(crate) base_url: String,
    pub(crate) model: String,
    pub(crate) api_key: Option<String>,
}

impl HarnessRuntimeConfig {
    /// Stable non-secret identity used for host caching and cancellation.
    /// Credentials are owned by DSH and may rotate without restarting a host.
    fn host_key(&self) -> String {
        format!("credential-ref:{}", self.api_key_env)
    }
}

/// Resolve the current model configuration into the native llm-pi-ai route.
/// Flowix supplies the selected connection and model, but never invents a
/// provider route of its own.
pub fn resolve_runtime_config(
    config: &AiModelConfig,
    runtime_model: Option<&str>,
) -> Result<HarnessRuntimeConfig, String> {
    let provider_route = config.provider_id.trim().to_string();
    if provider_route.is_empty() {
        return Err(
            "DeepSeek Harness provider route is not configured; open Models and configure a provider"
                .to_string(),
        );
    }
    if provider_route == "flowix" {
        return Err(
            "The saved DeepSeek Harness provider uses the obsolete Flowix route; open Models and reconfigure it"
                .to_string(),
        );
    }
    let provider_name = if config.display_name.trim().is_empty() {
        config.provider.trim()
    } else {
        config.display_name.trim()
    };
    if provider_name.is_empty() {
        return Err(format!(
            "DeepSeek Harness provider route {provider_route} has no display name; open Models and reconfigure it"
        ));
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
    let (inferred_api_protocol, default_base_url, _requires_api_key) = match normalized.as_str() {
        "anthropic" | "claude" => (
            "anthropic-messages",
            Some("https://api.anthropic.com/v1"),
            true,
        ),
        "kimiforcoding" | "minimax" | "minimaxcn" | "vercelaigateway" => {
            ("anthropic-messages", None, true)
        }
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
            return Err(format!(
            "DeepSeek Harness does not yet support Google/Gemini provider route {provider_route}"
        ))
        }
        _ => ("openai-completions", None, true),
    };
    let api_protocol = if config.api_protocol.trim().is_empty() {
        inferred_api_protocol
    } else {
        config.api_protocol.trim()
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

    let api_key_bucket = provider_route.as_str();
    let api_key = config.effective_api_key(api_key_bucket).trim().to_string();
    // A missing key is no longer a Flowix preflight failure. DSH's
    // credentials service resolves the reference at request time, so a key
    // stored by DSH (or rotated after startup) remains usable without an
    // environment-variable injection or host restart.

    let api_key_env = if config.api_key_env.trim().is_empty() {
        dsh_credential_ref_for_route(&provider_route)
    } else {
        config.api_key_env.trim().to_string()
    };

    Ok(HarnessRuntimeConfig {
        provider: provider_route,
        provider_name: (!config.display_name.trim().is_empty())
            .then(|| config.display_name.trim().to_string())
            .unwrap_or_else(|| provider_name.to_string()),
        api_protocol: api_protocol.to_string(),
        api_key_env,
        base_url,
        model: model.to_string(),
        api_key: (!api_key.is_empty()).then_some(api_key),
    })
}

/// Select the complete provider route for one conversation. A model id alone
/// is intentionally insufficient: two routes may expose the same id while
/// using different endpoints, protocols, and credentials.
fn select_harness_config(
    configs: Vec<AiConfigFile>,
    provider_id: Option<&str>,
) -> Result<AiModelConfig, String> {
    let requested = provider_id.map(str::trim).filter(|value| !value.is_empty());
    let selected = match requested {
        Some(route) => configs
            .into_iter()
            .find(|config| config.model.provider_id.trim() == route),
        None => configs.into_iter().next(),
    };
    selected
        .map(|config| config.model)
        .ok_or_else(|| match requested {
            Some(route) => format!("DeepSeek Harness provider route is not configured: {route}"),
            None => "DeepSeek Harness provider is not configured".to_string(),
        })
}

fn normalize_provider(provider: &str) -> String {
    provider
        .chars()
        .filter(|character| !character.is_whitespace() && *character != '-' && *character != '_')
        .flat_map(char::to_lowercase)
        .collect()
}

fn catalog_provider_id(provider: &str) -> Option<&'static str> {
    match normalize_provider(provider).as_str() {
        "anthropic" | "claude" => Some("anthropic"),
        "deepseek" => Some("deepseek"),
        "openrouter" => Some("openrouter"),
        "ollama" => Some("ollama"),
        "openai"
        | "openairesponses"
        | "openairesponsesapi"
        | "responsesapi"
        | "openaichatcompletions" => Some("openai"),
        _ => None,
    }
}

pub struct DeepSeekHarnessManager {
    thread_manager: Arc<ThreadManager>,
    user_config: Arc<UserConfigStore>,
    session_root: PathBuf,
    /// Harness child processes are keyed by credential. One process cannot
    /// safely serve two different API keys because the key is injected through
    /// its environment, but different keys can be used concurrently.
    hosts: Mutex<HashMap<String, Arc<DshHostClient>>>,
    active: Mutex<HashMap<String, ActiveRun>>,
}

const HARNESS_PROBE_TIMEOUT: Duration = Duration::from_secs(30);

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
            hosts: Mutex::new(HashMap::new()),
            active: Mutex::new(HashMap::new()),
        }
    }

    /// Run the model probe through the actual DeepSeek Harness runtime.
    ///
    /// This is intentionally separate from Flowix's provider probe. It uses
    /// an ephemeral Harness thread with the minimal preset and read-only
    /// permissions, and never writes the user's model configuration.
    pub async fn test_connection(&self, config: &AiModelConfig) -> TestConnectionResult {
        let started = Instant::now();
        let model_id = config.model.trim().to_string();
        let runtime_config = match resolve_runtime_config(config, None) {
            Ok(value) => value,
            Err(error) => {
                return harness_probe_failure(
                    &model_id,
                    started,
                    if error.contains("does not yet support") {
                        TestConnectionErrorKind::UnsupportedProvider
                    } else {
                        TestConnectionErrorKind::BadConfig
                    },
                    error,
                )
            }
        };

        // The durable settings file may still describe the previously saved
        // model directory while this draft is being tested. Harness treats an
        // explicit `models` list as authoritative, so probing through the
        // normal cached host would reject a newly added model as unknown.
        // Give this probe its own settings snapshot instead; no user config
        // is changed and the production host/cache is not disturbed.
        let probe_settings_path = match create_probe_settings_file(config) {
            Ok(path) => path,
            Err(error) => {
                return harness_probe_failure(
                    &model_id,
                    started,
                    TestConnectionErrorKind::Other,
                    error,
                )
            }
        };
        let dsh_home = self.user_config.dsh_dir();
        let probe_credentials_path = probe_settings_path.with_file_name(".credentials.yaml");
        if let Some(api_key) = runtime_config.api_key.as_deref() {
            if let Err(error) = sync_credential_file(
                &probe_credentials_path,
                &runtime_config.api_key_env,
                api_key,
            ) {
                let _ = fs::remove_file(&probe_settings_path);
                return harness_probe_failure(
                    &model_id,
                    started,
                    TestConnectionErrorKind::Other,
                    error,
                );
            }
        }
        let host = match tokio::time::timeout(
            HARNESS_PROBE_TIMEOUT,
            DshHostClient::spawn(
                &self.session_root,
                &dsh_home,
                &probe_settings_path,
                &probe_credentials_path,
                &self.plugin_settings_path(),
            ),
        )
        .await
        {
            Ok(Ok(host)) => host,
            Ok(Err(error)) => {
                let _ = fs::remove_file(&probe_settings_path);
                return harness_probe_failure(
                    &model_id,
                    started,
                    TestConnectionErrorKind::Other,
                    error,
                );
            }
            Err(_) => {
                let _ = fs::remove_file(&probe_settings_path);
                return harness_probe_failure(
                    &model_id,
                    started,
                    TestConnectionErrorKind::NetworkUnreachable,
                    format!(
                        "DeepSeek Harness did not start within {}s",
                        HARNESS_PROBE_TIMEOUT.as_secs()
                    ),
                );
            }
        };

        let probe_id = uuid::Uuid::new_v4().to_string();
        let thread_id = format!("flowix-harness-probe-{probe_id}");
        let session_id = format!("flowix-harness-probe-session-{probe_id}");
        let run_id = format!("flowix-harness-probe-run-{probe_id}");
        let cwd = std::env::temp_dir();

        let ensure = protocol::runtime_ensure_request(
            host.next_request_id(),
            &thread_id,
            Some(&session_id),
            &cwd.to_string_lossy(),
            &[],
            &runtime_config.provider,
            &runtime_config.provider_name,
            &runtime_config.api_protocol,
            &runtime_config.api_key_env,
            &runtime_config.base_url,
            &runtime_config.model,
            "minimal",
            "read-only",
        );
        if let Err(error) = timed_host_request(&host, ensure).await {
            cleanup_probe_host(&host, &thread_id, &probe_settings_path).await;
            return harness_probe_failure(
                &model_id,
                started,
                TestConnectionErrorKind::Other,
                error,
            );
        }
        let events = host.subscribe(&thread_id, &run_id).await;
        let start = protocol::run_start_request(
            host.next_request_id(),
            &thread_id,
            &run_id,
            "Reply with exactly: HARNESS_OK",
        );
        if let Err(error) = timed_host_request(&host, start).await {
            host.unsubscribe(&thread_id, &run_id).await;
            cleanup_probe_host(&host, &thread_id, &probe_settings_path).await;
            return harness_probe_failure(
                &model_id,
                started,
                TestConnectionErrorKind::Other,
                error,
            );
        }

        let event_thread_id = thread_id.clone();
        let outcome = tokio::time::timeout(HARNESS_PROBE_TIMEOUT, async move {
            let mut events = events;
            let mut summary = String::new();
            let mut saw_output = false;
            loop {
                let Some(value) = events.recv().await else {
                    return Err("DeepSeek Harness event stream closed".to_string());
                };
                match protocol::adapt_event(&value, &event_thread_id) {
                    AdaptedEvent::Chunk(AgentChunk::Text { text, .. })
                    | AdaptedEvent::Chunk(AgentChunk::Reasoning { text, .. }) => {
                        if !text.trim().is_empty() {
                            saw_output = true;
                        }
                        if summary.chars().count() < 80 {
                            summary.extend(text.chars().take(80 - summary.chars().count()));
                        }
                    }
                    AdaptedEvent::Chunk(AgentChunk::Error { message, .. }) => return Err(message),
                    AdaptedEvent::Completed(reason) => {
                        if reason.as_deref().unwrap_or("completed") != "completed" {
                            return Err(format!(
                                "DeepSeek Harness run ended: {}",
                                reason.unwrap_or_else(|| "unknown".to_string())
                            ));
                        }
                        if !saw_output {
                            return Err("DeepSeek Harness returned no assistant output".to_string());
                        }
                        return Ok(summary);
                    }
                    AdaptedEvent::Ignore
                    | AdaptedEvent::Chunk(AgentChunk::UserMessage { .. })
                    | AdaptedEvent::Chunk(AgentChunk::ToolCall { .. })
                    | AdaptedEvent::Chunk(AgentChunk::ToolResult { .. })
                    | AdaptedEvent::Chunk(AgentChunk::StreamStart { .. })
                    | AdaptedEvent::Chunk(AgentChunk::StreamEnd { .. })
                    | AdaptedEvent::Chunk(AgentChunk::SessionResolved { .. })
                    | AdaptedEvent::Chunk(AgentChunk::Usage { .. }) => {}
                }
            }
        })
        .await;

        host.unsubscribe(&thread_id, &run_id).await;
        cleanup_probe_host(&host, &thread_id, &probe_settings_path).await;

        match outcome {
            Ok(Ok(summary)) => TestConnectionResult {
                ok: true,
                latency_ms: started.elapsed().as_millis() as u64,
                model_id,
                summary,
                error: None,
            },
            Ok(Err(error)) => {
                harness_probe_failure(&model_id, started, TestConnectionErrorKind::Other, error)
            }
            Err(_) => harness_probe_failure(
                &model_id,
                started,
                TestConnectionErrorKind::NetworkUnreachable,
                format!(
                    "DeepSeek Harness did not finish within {}s",
                    HARNESS_PROBE_TIMEOUT.as_secs()
                ),
            ),
        }
    }

    /// Return the vendored llm-pi-ai catalog without requiring a configured
    /// provider or API key. The response is static and contains no secrets.
    pub async fn model_catalog(&self) -> Result<serde_json::Value, String> {
        let (host, ephemeral) = self.model_host().await?;
        let result = timed_host_request(
            &host,
            protocol::models_catalog_request(host.next_request_id()),
        )
        .await;
        if ephemeral {
            host.shutdown().await;
        }
        result
    }

    pub async fn session_usage(
        &self,
        thread_id: &str,
    ) -> Result<Option<DeepSeekHarnessSessionUsage>, String> {
        let session_id = self
            .thread_manager
            .get_external_session(thread_id, AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?;

        let instance = self
            .thread_manager
            .find_agent_conversation_by_thread_id(thread_id)
            .await
            .map_err(|error| error.to_string())?;
        let persisted_config = instance
            .as_ref()
            .and_then(|value| value.runtime_config.as_deref())
            .and_then(|raw| serde_json::from_str::<PersistedRuntimeConfig>(raw).ok());
        let provider_id = persisted_config
            .as_ref()
            .and_then(|config| config.model.as_ref())
            .and_then(|model| model.provider_id.as_deref());
        let model_id = persisted_config
            .as_ref()
            .and_then(|config| config.model.as_ref())
            .and_then(|model| model.key.as_deref());

        let configured = select_harness_config(
            self.user_config
                .get_deepseek_harness_configs()
                .map_err(|error| error.to_string())?,
            provider_id,
        )?;
        let runtime_config = resolve_runtime_config(&configured, model_id)?;
        let cwd = instance
            .as_ref()
            .and_then(|value| value.frozen_cwd.clone())
            .or_else(|| {
                persisted_config
                    .as_ref()
                    .and_then(|config| config.workspace_snapshot.as_ref())
                    .and_then(|snapshot| snapshot.cwd.clone())
            })
            .or_else(|| {
                persisted_config
                    .as_ref()
                    .and_then(|config| config.cwd.clone())
            })
            .unwrap_or_else(|| {
                std::env::current_dir()
                    .unwrap_or_else(|_| PathBuf::from("."))
                    .to_string_lossy()
                    .into_owned()
            });
        let workspace_paths = persisted_config
            .as_ref()
            .and_then(|config| config.workspace_snapshot.as_ref())
            .map(|snapshot| snapshot.workspace_paths.clone())
            .unwrap_or_default();
        let agent_preset = normalize_agent_preset(
            persisted_config
                .as_ref()
                .and_then(|config| config.deepseek_harness.as_ref())
                .and_then(|config| config.mode.as_deref()),
        );
        let permission = normalize_permission(
            persisted_config
                .as_ref()
                .and_then(|config| config.access.as_ref())
                .and_then(|config| config.sandbox.as_deref()),
        );

        let host = self.ensure_host(&runtime_config).await?;
        let ensure = protocol::runtime_ensure_request(
            host.next_request_id(),
            thread_id,
            session_id.as_deref(),
            &cwd,
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
        let session_id = resolved_session_id(host.request_value(ensure).await?)?;
        self.thread_manager
            .upsert_external_session(thread_id, AGENT_TYPE, &session_id, None)
            .await
            .map_err(|error| error.to_string())?;
        let result = timed_host_request(
            &host,
            protocol::session_usage_request(host.next_request_id(), &session_id),
        )
        .await?;
        if result.is_null() {
            return Ok(None);
        }
        serde_json::from_value(result)
            .map(Some)
            .map_err(|error| format!("invalid DeepSeek Harness session usage: {error}"))
    }

    /// Return the plugin rows from the same host and agent-preset compositions
    /// used by dsh-host. This is metadata only and does not require a model or
    /// API key, so the preferences page can load it before the first chat.
    pub async fn plugin_catalog(&self) -> Result<serde_json::Value, String> {
        let (host, ephemeral) = self.model_host().await?;
        let result = timed_host_request(
            &host,
            protocol::plugins_catalog_request(host.next_request_id()),
        )
        .await;
        if ephemeral {
            host.shutdown().await;
        }
        result.and_then(|value| {
            value
                .get("plugins")
                .filter(|plugins| plugins.is_object())
                .cloned()
                .or_else(|| {
                    // Accept the unwrapped shape too so the desktop client
                    // remains compatible with hosts that expose the catalog
                    // directly.
                    (value.get("host").is_some() && value.get("presets").is_some())
                        .then_some(value.clone())
                })
                .ok_or_else(|| "DeepSeek Harness returned an invalid plugin catalog".to_string())
        })
    }

    pub async fn set_plugin_enabled(
        &self,
        plugin_key: &str,
        enabled: bool,
    ) -> Result<serde_json::Value, String> {
        validate_plugin_key(plugin_key)?;
        if !self.active.lock().await.is_empty() {
            return Err("DeepSeek Harness 插件运行中不可切换，请先停止当前任务".to_string());
        }

        self.user_config
            .set_deepseek_harness_plugin_enabled(plugin_key, enabled)
            .map_err(|error| error.to_string())?;

        let hosts = {
            let mut hosts = self.hosts.lock().await;
            hosts.drain().map(|(_, host)| host).collect::<Vec<_>>()
        };
        for host in hosts {
            host.shutdown().await;
        }

        self.plugin_catalog().await
    }

    /// Backwards-compatible flat model list for older callers. New DSH UI code
    /// uses `deepseekHarness.list()` so it can retain the provider route next
    /// to every model id; this method intentionally remains string-only.
    pub async fn supported_models(&self) -> Result<Vec<String>, String> {
        let configs = self
            .user_config
            .get_deepseek_harness_configs()
            .map_err(|error| error.to_string())?
            .into_iter()
            .flat_map(|config| {
                let model = config.model;
                if model.models.is_empty() {
                    vec![model.model].into_iter()
                } else {
                    model
                        .models
                        .into_iter()
                        .map(|entry| entry.id)
                        .collect::<Vec<_>>()
                        .into_iter()
                }
            })
            .map(|id| id.trim().to_string())
            .filter(|id| !id.is_empty())
            .collect::<Vec<_>>();
        let mut seen = HashSet::new();
        let models = configs
            .into_iter()
            .filter(|id| seen.insert(id.clone()))
            .collect();
        Ok(models)
    }

    /// Discover models for the provider draft currently being edited. The key
    /// is sent only in this one request and is never persisted by the host.
    pub async fn discover_models(
        &self,
        config: &AiModelConfig,
    ) -> Result<serde_json::Value, String> {
        let runtime_config = resolve_runtime_config(config, None)?;
        let provider = catalog_provider_id(&runtime_config.provider_name);
        let (host, ephemeral) = self.model_host().await?;
        let request = protocol::models_discover_request(
            host.next_request_id(),
            provider,
            &runtime_config.base_url,
            &runtime_config.api_protocol,
            runtime_config.api_key.as_deref(),
        );
        let result = timed_host_request(&host, request).await;
        if ephemeral {
            host.shutdown().await;
        }
        result
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
        let session_id = self
            .thread_manager
            .get_external_session(&thread_id, AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?;
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
                    session_id: session_id.clone().unwrap_or_default(),
                    stream_end_emitted: stream_end_emitted.clone(),
                    host_key: None,
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
        session_id: Option<&str>,
        message: &AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<Option<String>, String> {
        let cwd = resolve_and_freeze_runtime_cwd(
            &self.thread_manager,
            thread_id,
            |message, _| message.cwd_for_runtime(AGENT_TYPE).map(PathBuf::from),
            message,
            session_id.as_deref(),
            None,
        )
        .await?;
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
        self.set_active_host_key(thread_id, run_id, runtime_config.host_key())
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
        let session_id = resolved_session_id(host.request_value(ensure).await?)?;
        self.set_active_session_id(thread_id, run_id, &session_id)
            .await;
        self.thread_manager
            .upsert_external_session(thread_id, AGENT_TYPE, &session_id, None)
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
        let host_key = runtime_config.host_key();
        let dsh_home = self.user_config.dsh_dir();
        let credentials_path = dsh_home.join(".credentials.yaml");
        if let Some(api_key) = runtime_config.api_key.as_deref() {
            sync_credential_file(&credentials_path, &runtime_config.api_key_env, api_key)?;
        }
        let mut hosts = self.hosts.lock().await;
        if let Some(host) = hosts.get(&host_key).filter(|host| !host.is_closed()) {
            return Ok(host.clone());
        }
        std::fs::create_dir_all(&self.session_root)
            .map_err(|error| format!("failed to create DSH session root: {error}"))?;
        let settings_path = self.user_config.dsh_settings_path();
        let plugin_settings_path = self.plugin_settings_path();
        let host = DshHostClient::spawn(
            &self.session_root,
            &dsh_home,
            &settings_path,
            &credentials_path,
            &plugin_settings_path,
        )
        .await?;
        hosts.insert(host_key, host.clone());
        Ok(host)
    }

    async fn model_host(&self) -> Result<(Arc<DshHostClient>, bool), String> {
        if let Some(host) = self
            .hosts
            .lock()
            .await
            .values()
            .find(|host| !host.is_closed())
        {
            return Ok((host.clone(), false));
        }
        std::fs::create_dir_all(&self.session_root)
            .map_err(|error| format!("failed to create DSH session root: {error}"))?;
        let dsh_home = self.user_config.dsh_dir();
        let settings_path = self.user_config.dsh_settings_path();
        let credentials_path = dsh_home.join(".credentials.yaml");
        let plugin_settings_path = self.plugin_settings_path();
        Ok((
            DshHostClient::spawn(
                &self.session_root,
                &dsh_home,
                &settings_path,
                &credentials_path,
                &plugin_settings_path,
            )
            .await?,
            true,
        ))
    }

    fn plugin_settings_path(&self) -> PathBuf {
        self.user_config.dsh_plugin_settings_path()
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
                (run_id.is_none() || run_id == Some(run.run_id.as_str())).then(|| {
                    (
                        run.run_id.clone(),
                        run.stream_end_emitted.clone(),
                        run.host_key.clone(),
                    )
                })
            })
        };
        let Some((run_id, stream_end_emitted, host_key)) = target else {
            return false;
        };
        let hosts = {
            let hosts = self.hosts.lock().await;
            match host_key {
                Some(host_key) => hosts
                    .get(&host_key)
                    .cloned()
                    .into_iter()
                    .collect::<Vec<_>>(),
                // A run can fail before its route is resolved. In that case
                // retain the legacy best-effort cancellation across hosts.
                None => hosts.values().cloned().collect::<Vec<_>>(),
            }
        };
        for host in hosts {
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
        let hosts = std::mem::take(&mut *self.hosts.lock().await);
        for host in hosts.into_values() {
            host.shutdown().await;
        }
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

    async fn set_active_host_key(&self, thread_id: &str, run_id: &str, host_key: String) {
        if let Some(active) = self.active.lock().await.get_mut(thread_id) {
            if active.run_id == run_id {
                active.host_key = Some(host_key);
            }
        }
    }

    async fn set_active_session_id(&self, thread_id: &str, run_id: &str, session_id: &str) {
        if let Some(active) = self.active.lock().await.get_mut(thread_id) {
            if active.run_id == run_id {
                active.session_id = session_id.to_string();
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

    /// Close all cached hosts before a provider, credential, or plugin
    /// configuration change. A live run must finish first: closing its host
    /// would terminate the runtime underneath an in-flight tool call.
    pub async fn invalidate_hosts(&self) -> Result<(), String> {
        if !self.active.lock().await.is_empty() {
            return Err("DeepSeek Harness 配置运行中不可修改，请先停止当前任务".to_string());
        }
        let hosts = {
            let mut hosts = self.hosts.lock().await;
            hosts.drain().map(|(_, host)| host).collect::<Vec<_>>()
        };
        for host in hosts {
            host.shutdown().await;
        }
        Ok(())
    }

    /// Shut down every dsh-host child before the managed runtime is
    /// uninstalled. Refuses while a Harness run is active: deleting the
    /// binary underneath a live session would strand the run without its
    /// final StreamEnd. `~/.dsh` user state is untouched by the caller.
    pub async fn prepare_uninstall(&self) -> Result<(), String> {
        if !self.active.lock().await.is_empty() {
            return Err("DeepSeek Harness 正在运行任务，请先停止后再卸载".to_string());
        }
        let hosts = {
            let mut hosts = self.hosts.lock().await;
            hosts.drain().map(|(_, host)| host).collect::<Vec<_>>()
        };
        for host in hosts {
            host.shutdown().await;
        }
        Ok(())
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

async fn timed_host_request(
    host: &Arc<DshHostClient>,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    match tokio::time::timeout(HARNESS_PROBE_TIMEOUT, host.request_value(request)).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "DeepSeek Harness request timed out after {}s",
            HARNESS_PROBE_TIMEOUT.as_secs()
        )),
    }
}

async fn dispose_probe_runtime(host: &Arc<DshHostClient>, thread_id: &str) {
    let request = protocol::runtime_dispose_request(host.next_request_id(), thread_id);
    let _ = tokio::time::timeout(Duration::from_secs(2), host.request_value(request)).await;
}

/// Create the settings snapshot consumed by one probe runtime.
///
/// The active model is added even when the form's directory still contains
/// only the previously saved models. This is the exact transition involved
/// when adding model B after model A.
fn create_probe_settings_file(config: &AiModelConfig) -> Result<PathBuf, String> {
    let mut probe_config = config.clone();
    let model_id = probe_config.model.trim().to_string();
    if !model_id.is_empty() && !probe_config.models.iter().any(|model| model.id == model_id) {
        probe_config.models.push(AiModelEntry {
            id: model_id,
            name: String::new(),
        });
    }
    let content = UserConfigStore::deepseek_harness_settings_yaml(&probe_config)
        .map_err(|error| format!("failed to prepare Harness probe settings: {error}"))?;
    let path = std::env::temp_dir().join(format!("flowix-dsh-probe-{}.yaml", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| format!("failed to create Harness probe settings: {error}"))?;
        file.write_all(content.as_bytes())
            .map_err(|error| format!("failed to write Harness probe settings: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("failed to flush Harness probe settings: {error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("failed to secure Harness probe settings: {error}"))?;
        }
        Ok(path.clone())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&path);
    }
    result
}

async fn cleanup_probe_host(host: &Arc<DshHostClient>, thread_id: &str, settings_path: &PathBuf) {
    dispose_probe_runtime(host, thread_id).await;
    host.shutdown().await;
    let _ = fs::remove_file(settings_path);
    let _ = fs::remove_file(settings_path.with_file_name(".credentials.yaml"));
}

fn harness_probe_failure(
    model_id: &str,
    started: Instant,
    kind: TestConnectionErrorKind,
    message: String,
) -> TestConnectionResult {
    TestConnectionResult {
        ok: false,
        latency_ms: started.elapsed().as_millis() as u64,
        model_id: model_id.to_string(),
        summary: String::new(),
        error: Some(TestConnectionError { kind, message }),
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

fn validate_plugin_key(plugin_key: &str) -> Result<(), String> {
    let parts = plugin_key.split(':').collect::<Vec<_>>();
    if parts.iter().any(|part| part.is_empty()) {
        return Err("DeepSeek Harness 插件标识无效".to_string());
    }
    if matches!(parts.as_slice(), ["host", _])
        || matches!(parts.as_slice(), ["host", index, _]
            if index.chars().all(|character| character.is_ascii_digit()))
    {
        return Err("Host 级 Harness 插件由 Flowix 组合管理，不可单独关闭".to_string());
    }
    let valid_preset = |preset: &str| matches!(preset, "standard" | "code" | "minimal" | "cordis");
    if matches!(parts.as_slice(), ["preset", preset, _] if valid_preset(preset))
        || matches!(parts.as_slice(), ["preset", preset, index, _]
            if valid_preset(preset) && index.chars().all(|character| character.is_ascii_digit()))
    {
        return Ok(());
    }
    Err("DeepSeek Harness 插件标识无效".to_string())
}

fn resolved_session_id(value: serde_json::Value) -> Result<String, String> {
    value
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| "DeepSeek Harness did not return a session id".to_string())
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
