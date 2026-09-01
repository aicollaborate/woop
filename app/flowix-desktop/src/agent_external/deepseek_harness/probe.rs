use std::time::Instant;

use super::error::harness_probe_failure;
use super::manager::DeepSeekHarnessManager;
use super::protocol;
use crate::config::AiModelConfig;
use crate::connection_probe::{TestConnectionErrorKind, TestConnectionResult};

impl DeepSeekHarnessManager {
    /// Probe through the same dsh-appserver connection used by conversations.
    /// Flowix deliberately has no SDK-server fallback.
    pub async fn test_connection(&self, config: &AiModelConfig) -> TestConnectionResult {
        let started = Instant::now();
        let model_id = config.model.trim().to_string();
        let host = match self.model_host().await {
            Ok(host) => host,
            Err(error) => return harness_probe_failure(
                &model_id, started, TestConnectionErrorKind::Other, error,
            ),
        };
        let route = if config.provider_id.trim().is_empty() {
            config.provider.trim()
        } else {
            config.provider_id.trim()
        };
        let request = protocol::model_discover_request(
            host.next_request_id(),
            Some(route),
            &config.api_url,
            &config.api_protocol,
            Some(config.effective_api_key(route)).filter(|value| !value.is_empty()),
        );
        match host.request(request).await {
            Ok(_) => TestConnectionResult {
                ok: true,
                latency_ms: started.elapsed().as_millis() as u64,
                model_id,
                summary: String::new(),
                error: None,
            },
            Err(error) => harness_probe_failure(
                &model_id, started, TestConnectionErrorKind::Other, error,
            ),
        }
    }
}
