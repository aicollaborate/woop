use super::protocol;
use super::transport::DshClient;
use crate::config::{AiModelConfig, AiModelEntry, UserConfigStore};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) async fn timed_host_request<C: DshClient + ?Sized>(
    host: &Arc<C>,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    timed_host_request_with_timeout(host, request, PROBE_TIMEOUT).await
}

async fn timed_host_request_with_timeout<C: DshClient + ?Sized>(
    host: &Arc<C>,
    request: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    match tokio::time::timeout(timeout, host.request(request)).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "DeepSeek Harness request timed out after {}s",
            timeout.as_secs()
        )),
    }
}

async fn dispose_probe_runtime<C: DshClient + ?Sized>(host: &Arc<C>, thread_id: &str) {
    let request = protocol::runtime_dispose_request(host.next_request_id(), thread_id);
    let _ = tokio::time::timeout(Duration::from_secs(2), host.request(request)).await;
}

pub(crate) fn create_probe_settings_file(config: &AiModelConfig) -> Result<PathBuf, String> {
    let mut snapshot = config.clone();
    let model_id = snapshot.model.trim().to_string();
    if !model_id.is_empty() && !snapshot.models.iter().any(|model| model.id == model_id) {
        snapshot.models.push(AiModelEntry {
            id: model_id,
            name: String::new(),
        });
    }
    let content = UserConfigStore::deepseek_harness_settings_yaml(&snapshot)
        .map_err(|e| format!("failed to prepare Harness probe settings: {e}"))?;
    let directory = std::env::temp_dir().join(format!("flowix-dsh-probe-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&directory)
        .map_err(|e| format!("failed to create Harness probe directory: {e}"))?;
    let path = directory.join("settings.yaml");
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| format!("failed to create Harness probe settings: {e}"))?;
        file.write_all(content.as_bytes())
            .map_err(|e| format!("failed to write Harness probe settings: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("failed to flush Harness probe settings: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
                .map_err(|e| format!("failed to secure Harness probe settings: {e}"))?;
        }
        Ok(path.clone())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&directory);
    }
    result
}

/// Remove the private settings directory created for one connection probe.
pub(crate) fn cleanup_probe_files(settings_path: &Path) {
    if let Some(directory) = settings_path.parent() {
        let _ = fs::remove_dir_all(directory);
    }
}

pub(crate) async fn cleanup_probe_host<C: DshClient + ?Sized>(
    host: &Arc<C>,
    thread_id: &str,
    settings_path: &Path,
    temporary_credential: Option<&str>,
) {
    dispose_probe_runtime(host, thread_id).await;
    if let Some(reference) = temporary_credential {
        let request = protocol::credential_delete_request(host.next_request_id(), reference);
        let _ = tokio::time::timeout(Duration::from_secs(2), host.request(request)).await;
    }
    host.shutdown().await;
    cleanup_probe_files(settings_path);
}

#[cfg(test)]
mod tests {
    use super::super::transport::{fake::FakeDshClient, DshClient};
    use super::*;
    use std::sync::Arc;
    use tokio::sync::mpsc;

    struct PendingClient;
    #[async_trait::async_trait]
    impl DshClient for PendingClient {
        fn next_request_id(&self) -> u64 {
            1
        }
        fn is_closed(&self) -> bool {
            false
        }
        async fn request(&self, _value: serde_json::Value) -> Result<serde_json::Value, String> {
            std::future::pending().await
        }
        async fn subscribe(
            &self,
            _thread_id: &str,
            _run_id: &str,
        ) -> mpsc::UnboundedReceiver<serde_json::Value> {
            let (_tx, rx) = mpsc::unbounded_channel();
            rx
        }
        async fn unsubscribe(&self, _thread_id: &str, _run_id: &str) {}
        async fn shutdown(&self) {}
    }

    #[test]
    fn probe_snapshot_includes_unsaved_active_model() {
        let config = AiModelConfig {
            provider: "deepseek".into(),
            provider_id: "deepseek".into(),
            model: "model-b".into(),
            models: vec![AiModelEntry {
                id: "model-a".into(),
                name: String::new(),
            }],
            ..Default::default()
        };
        let path = create_probe_settings_file(&config).unwrap();
        let settings = fs::read_to_string(&path).unwrap();
        let _ = fs::remove_file(path);
        assert!(settings.contains("model-b"));
    }

    #[tokio::test]
    async fn transport_errors_are_preserved_by_probe_boundary() {
        let host = Arc::new(FakeDshClient::new(vec![Err("offline".into())]));
        assert_eq!(
            timed_host_request(&host, serde_json::Value::Null)
                .await
                .unwrap_err(),
            "offline"
        );
    }

    #[tokio::test]
    async fn stalled_transport_is_bounded_by_timeout() {
        let host = Arc::new(PendingClient);
        let error = timed_host_request_with_timeout(
            &host,
            serde_json::Value::Null,
            Duration::from_millis(1),
        )
        .await
        .unwrap_err();
        assert!(error.contains("timed out"));
    }

    #[tokio::test]
    async fn cleanup_disposes_shutdowns_and_removes_probe_files() {
        let host = Arc::new(FakeDshClient::new(vec![Ok(serde_json::json!({}))]));
        let temp = tempfile::tempdir().unwrap();
        let settings = temp.path().join("probe.yaml");
        let credentials = temp.path().join(".credentials.yaml");
        fs::write(&settings, b"x").unwrap();
        fs::write(&credentials, b"x").unwrap();
        cleanup_probe_host(&host, "probe-thread", &settings, None).await;
        assert!(host.is_closed());
        assert!(!settings.exists());
        assert!(!credentials.exists());
    }
}
