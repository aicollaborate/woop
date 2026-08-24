use std::collections::HashSet;
use std::path::PathBuf;

use super::config::{
    catalog_provider_id, normalize_agent_preset, normalize_permission, resolve_runtime_config,
    select_harness_config, PersistedRuntimeConfig,
};
use super::discovery::timed_host_request;
use super::error::{resolved_session_id, validate_plugin_key};
use super::manager::{DeepSeekHarnessManager, DeepSeekHarnessSessionUsage};
use super::protocol;
use super::transport::DshClient;
use super::AGENT_TYPE;
use crate::config::AiModelConfig;

impl DeepSeekHarnessManager {
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
        let session_id = resolved_session_id(host.request(ensure).await?)?;
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
        if !self.runs.is_empty().await {
            return Err("DeepSeek Harness 插件运行中不可切换，请先停止当前任务".to_string());
        }

        self.user_config
            .set_deepseek_harness_plugin_enabled(plugin_key, enabled)
            .map_err(|error| error.to_string())?;

        self.hosts.shutdown_all().await;

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
}
