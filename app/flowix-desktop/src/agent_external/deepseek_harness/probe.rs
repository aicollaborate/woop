use std::sync::Arc;
use std::time::Instant;

use super::config::resolve_runtime_config;
use super::discovery::{
    cleanup_probe_files, cleanup_probe_host, create_probe_settings_file, timed_host_request,
};
use super::error::harness_probe_failure;
use super::host::DshHostClient;
use super::manager::{DeepSeekHarnessManager, HARNESS_PROBE_TIMEOUT};
use super::protocol::{self, AdaptedEvent};
use crate::agent_wire::AgentChunk;
use crate::config::AiModelConfig;
use crate::connection_probe::{TestConnectionErrorKind, TestConnectionResult};

impl DeepSeekHarnessManager {
    /// Run the model probe through the actual DeepSeek Harness runtime.
    ///
    /// This is intentionally separate from Flowix's provider probe. It uses
    /// an ephemeral Harness thread with the minimal preset and read-only
    /// permissions, and never writes the user's model configuration.
    pub async fn test_connection(&self, config: &AiModelConfig) -> TestConnectionResult {
        let started = Instant::now();
        let model_id = config.model.trim().to_string();
        let mut runtime_config = match resolve_runtime_config(config, None) {
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
        // A draft key is stored under a one-shot DSH credential reference,
        // never over the route's saved reference. DSH deletes it at cleanup;
        // Flowix never reads or copies the credentials document.
        let temporary_credential = runtime_config
            .api_key
            .as_ref()
            .map(|_| format!("FLOWIX_DSH_PROBE_{}", uuid::Uuid::new_v4().simple()));
        let mut probe_config = config.clone();
        if let Some(reference) = temporary_credential.as_deref() {
            runtime_config.api_key_env = reference.to_string();
            probe_config.api_key_env = reference.to_string();
        }

        // The durable settings file may still describe the previously saved
        // model directory while this draft is being tested. Harness treats an
        // explicit `models` list as authoritative, so probing through the
        // normal cached host would reject a newly added model as unknown.
        // Give this probe its own settings snapshot instead; no user config
        // is changed and the production host/cache is not disturbed.
        let probe_settings_path = match create_probe_settings_file(&probe_config) {
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
        let probe_credentials_path = dsh_home.join(".credentials.yaml");
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
                cleanup_probe_files(&probe_settings_path);
                return harness_probe_failure(
                    &model_id,
                    started,
                    TestConnectionErrorKind::Other,
                    error,
                );
            }
            Err(_) => {
                cleanup_probe_files(&probe_settings_path);
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

        let credential_request = if let Some(api_key) = runtime_config.api_key.as_deref() {
            protocol::credential_set_request(
                host.next_request_id(),
                &runtime_config.api_key_env,
                api_key,
            )
        } else {
            protocol::credential_status_request(host.next_request_id(), &runtime_config.api_key_env)
        };
        match timed_host_request(&host, credential_request).await {
            Ok(value)
                if value.get("configured").and_then(serde_json::Value::as_bool) == Some(true) => {}
            Ok(_) => {
                cleanup_probe_host(
                    &host,
                    "flowix-probe-credential-only",
                    &probe_settings_path,
                    temporary_credential.as_deref(),
                )
                .await;
                return harness_probe_failure(
                    &model_id,
                    started,
                    TestConnectionErrorKind::BadConfig,
                    "API key is not configured in DeepSeek Harness".to_string(),
                );
            }
            Err(error) => {
                cleanup_probe_host(
                    &host,
                    "flowix-probe-credential-only",
                    &probe_settings_path,
                    temporary_credential.as_deref(),
                )
                .await;
                return harness_probe_failure(
                    &model_id,
                    started,
                    TestConnectionErrorKind::Other,
                    error,
                );
            }
        }

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
            cleanup_probe_host(
                &host,
                &thread_id,
                &probe_settings_path,
                temporary_credential.as_deref(),
            )
            .await;
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
            "Reply with exactly: HARNESS_OK",
            "flowix-probe-message",
        );
        if let Err(error) = timed_host_request(&host, start).await {
            host.unsubscribe(&thread_id, &run_id).await;
            cleanup_probe_host(
                &host,
                &thread_id,
                &probe_settings_path,
                temporary_credential.as_deref(),
            )
            .await;
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
        cleanup_probe_host(
            &host,
            &thread_id,
            &probe_settings_path,
            temporary_credential.as_deref(),
        )
        .await;

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
}
