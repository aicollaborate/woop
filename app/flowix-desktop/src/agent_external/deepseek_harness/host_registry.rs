use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

use super::host::{sync_credential_file, DshHostClient};
use super::transport::DshClient;

#[derive(Clone)]
pub(crate) struct HostLaunchSpec {
    pub(crate) session_root: PathBuf,
    pub(crate) dsh_home: PathBuf,
    pub(crate) settings_path: PathBuf,
    pub(crate) credentials_path: PathBuf,
    pub(crate) plugin_settings_path: PathBuf,
}

#[async_trait::async_trait]
pub(crate) trait DshClientFactory: Send + Sync {
    async fn spawn(&self, spec: &HostLaunchSpec) -> Result<Arc<dyn DshClient>, String>;
}

pub(crate) struct ProcessDshClientFactory;
#[async_trait::async_trait]
impl DshClientFactory for ProcessDshClientFactory {
    async fn spawn(&self, spec: &HostLaunchSpec) -> Result<Arc<dyn DshClient>, String> {
        let client: Arc<dyn DshClient> = DshHostClient::spawn(
            &spec.session_root,
            &spec.dsh_home,
            &spec.settings_path,
            &spec.credentials_path,
            &spec.plugin_settings_path,
        )
        .await?;
        Ok(client)
    }
}

pub(crate) struct HostRegistry {
    hosts: Mutex<HashMap<String, Arc<dyn DshClient>>>,
    factory: Arc<dyn DshClientFactory>,
}

impl HostRegistry {
    pub(crate) fn new(factory: Arc<dyn DshClientFactory>) -> Self {
        Self {
            hosts: Mutex::new(HashMap::new()),
            factory,
        }
    }

    pub(crate) async fn ensure(
        &self,
        key: &str,
        spec: &HostLaunchSpec,
        credential: Option<(&str, &str)>,
    ) -> Result<Arc<dyn DshClient>, String> {
        if let Some((reference, secret)) = credential {
            sync_credential_file(&spec.credentials_path, reference, secret)?;
        }
        // Holding the registry lock across spawn intentionally provides a
        // single-flight guarantee. Host startup is rare and bounded; duplicate
        // children would be more dangerous than serial startup across routes.
        let mut hosts = self.hosts.lock().await;
        if let Some(host) = hosts.get(key).filter(|host| !host.is_closed()) {
            return Ok(host.clone());
        }
        std::fs::create_dir_all(&spec.session_root)
            .map_err(|e| format!("failed to create DSH session root: {e}"))?;
        let host = self.factory.spawn(spec).await?;
        hosts.insert(key.into(), host.clone());
        Ok(host)
    }

    pub(crate) async fn existing_or_ephemeral(
        &self,
        spec: &HostLaunchSpec,
    ) -> Result<(Arc<dyn DshClient>, bool), String> {
        if let Some(host) = self
            .hosts
            .lock()
            .await
            .values()
            .find(|host| !host.is_closed())
            .cloned()
        {
            return Ok((host, false));
        }
        std::fs::create_dir_all(&spec.session_root)
            .map_err(|e| format!("failed to create DSH session root: {e}"))?;
        Ok((self.factory.spawn(spec).await?, true))
    }

    pub(crate) async fn cancellation_targets(&self, key: Option<&str>) -> Vec<Arc<dyn DshClient>> {
        let hosts = self.hosts.lock().await;
        match key {
            Some(key) => hosts.get(key).cloned().into_iter().collect(),
            None => hosts.values().cloned().collect(),
        }
    }

    pub(crate) async fn shutdown_all(&self) -> usize {
        let hosts = std::mem::take(&mut *self.hosts.lock().await);
        let count = hosts.len();
        for host in hosts.into_values() {
            host.shutdown().await;
        }
        count
    }
}

#[cfg(test)]
mod tests {
    use super::super::transport::fake::FakeDshClient;
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FakeFactory {
        spawns: AtomicUsize,
    }
    #[async_trait::async_trait]
    impl DshClientFactory for FakeFactory {
        async fn spawn(&self, _spec: &HostLaunchSpec) -> Result<Arc<dyn DshClient>, String> {
            self.spawns.fetch_add(1, Ordering::SeqCst);
            Ok(Arc::new(FakeDshClient::new(Vec::new())))
        }
    }
    fn spec(root: PathBuf) -> HostLaunchSpec {
        HostLaunchSpec {
            session_root: root.clone(),
            dsh_home: root.clone(),
            settings_path: root.join("settings"),
            credentials_path: root.join("credentials"),
            plugin_settings_path: root.join("plugins"),
        }
    }

    #[tokio::test]
    async fn concurrent_ensure_is_single_flight_per_key() {
        let factory = Arc::new(FakeFactory {
            spawns: AtomicUsize::new(0),
        });
        let registry = Arc::new(HostRegistry::new(factory.clone()));
        let temp = tempfile::tempdir().unwrap();
        let spec = spec(temp.path().to_path_buf());
        let (a, b) = tokio::join!(
            registry.ensure("route", &spec, None),
            registry.ensure("route", &spec, None)
        );
        assert!(Arc::ptr_eq(&a.unwrap(), &b.unwrap()));
        assert_eq!(factory.spawns.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn closed_host_is_replaced_and_shutdown_clears_registry() {
        let factory = Arc::new(FakeFactory {
            spawns: AtomicUsize::new(0),
        });
        let registry = HostRegistry::new(factory.clone());
        let temp = tempfile::tempdir().unwrap();
        let spec = spec(temp.path().to_path_buf());
        let first = registry.ensure("route", &spec, None).await.unwrap();
        first.shutdown().await;
        let second = registry.ensure("route", &spec, None).await.unwrap();
        assert!(!Arc::ptr_eq(&first, &second));
        assert_eq!(registry.shutdown_all().await, 1);
        assert_eq!(factory.spawns.load(Ordering::SeqCst), 2);
    }
}
