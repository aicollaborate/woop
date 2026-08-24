use crate::agent_session::ThreadManager;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[async_trait::async_trait]
trait SessionStore: Send + Sync {
    async fn session_id(&self, thread_id: &str, agent_type: &str)
        -> Result<Option<String>, String>;
    async fn frozen_cwd(&self, thread_id: &str) -> Result<Option<PathBuf>, String>;
    async fn commit_cwd(&self, thread_id: &str, cwd: &Path) -> Result<(), String>;
    async fn commit_session(
        &self,
        thread_id: &str,
        agent_type: &str,
        session_id: &str,
    ) -> Result<(), String>;
}

struct ThreadSessionStore {
    threads: Arc<ThreadManager>,
}
#[async_trait::async_trait]
impl SessionStore for ThreadSessionStore {
    async fn session_id(
        &self,
        thread_id: &str,
        agent_type: &str,
    ) -> Result<Option<String>, String> {
        self.threads
            .get_external_session(thread_id, agent_type)
            .await
            .map_err(|e| e.to_string())
    }
    async fn frozen_cwd(&self, thread_id: &str) -> Result<Option<PathBuf>, String> {
        self.threads
            .read_frozen_cwd(thread_id)
            .await
            .map_err(|e| e.to_string())
    }
    async fn commit_cwd(&self, thread_id: &str, cwd: &Path) -> Result<(), String> {
        self.threads
            .upsert_frozen_cwd(thread_id, cwd)
            .await
            .map_err(|e| e.to_string())
    }
    async fn commit_session(
        &self,
        thread_id: &str,
        agent_type: &str,
        session_id: &str,
    ) -> Result<(), String> {
        self.threads
            .upsert_external_session(thread_id, agent_type, session_id, None)
            .await
            .map_err(|e| e.to_string())
    }
}

pub(crate) struct SessionRegistry {
    store: Arc<dyn SessionStore>,
    agent_type: &'static str,
}
impl SessionRegistry {
    pub(crate) fn new(threads: Arc<ThreadManager>, agent_type: &'static str) -> Self {
        Self {
            store: Arc::new(ThreadSessionStore { threads }),
            agent_type,
        }
    }
    #[cfg(test)]
    fn with_store(store: Arc<dyn SessionStore>, agent_type: &'static str) -> Self {
        Self { store, agent_type }
    }
    pub(crate) async fn session_id(&self, thread_id: &str) -> Result<Option<String>, String> {
        self.store.session_id(thread_id, self.agent_type).await
    }
    pub(crate) async fn resolve_cwd(
        &self,
        thread_id: &str,
        requested: Option<PathBuf>,
    ) -> Result<PathBuf, String> {
        if let Some(cwd) = requested.filter(|cwd| cwd.is_dir()) {
            return Ok(cwd);
        }
        self.store
            .frozen_cwd(thread_id)
            .await?
            .filter(|cwd| cwd.is_dir())
            .ok_or_else(|| {
                "Agent working directory unavailable; open a notebook or pick a folder".into()
            })
    }
    pub(crate) async fn commit(
        &self,
        thread_id: &str,
        session_id: &str,
        cwd: &Path,
    ) -> Result<(), String> {
        if let Err(error) = self.store.commit_cwd(thread_id, cwd).await {
            tracing::warn!(thread_id, cwd = %cwd.display(), %error, "failed to commit harness workspace");
        }
        self.store
            .commit_session(thread_id, self.agent_type, session_id)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::Mutex;

    #[derive(Default)]
    struct FakeStore {
        frozen: Option<PathBuf>,
        frozen_error: Option<String>,
        session_error: Option<String>,
        commits: Mutex<Vec<String>>,
    }
    #[async_trait::async_trait]
    impl SessionStore for FakeStore {
        async fn session_id(
            &self,
            _thread_id: &str,
            _agent_type: &str,
        ) -> Result<Option<String>, String> {
            Ok(Some("s1".into()))
        }
        async fn frozen_cwd(&self, _thread_id: &str) -> Result<Option<PathBuf>, String> {
            self.frozen_error
                .clone()
                .map_or(Ok(self.frozen.clone()), Err)
        }
        async fn commit_cwd(&self, _thread_id: &str, _cwd: &Path) -> Result<(), String> {
            self.commits.lock().await.push("cwd".into());
            Ok(())
        }
        async fn commit_session(
            &self,
            _thread_id: &str,
            _agent_type: &str,
            _session_id: &str,
        ) -> Result<(), String> {
            self.commits.lock().await.push("session".into());
            self.session_error.clone().map_or(Ok(()), Err)
        }
    }

    #[tokio::test]
    async fn requested_directory_wins_over_frozen_cwd() {
        let requested = tempfile::tempdir().unwrap();
        let frozen = tempfile::tempdir().unwrap();
        let store = Arc::new(FakeStore {
            frozen: Some(frozen.path().into()),
            ..Default::default()
        });
        let registry = SessionRegistry::with_store(store, "dsh");
        assert_eq!(
            registry
                .resolve_cwd("t", Some(requested.path().into()))
                .await
                .unwrap(),
            requested.path()
        );
    }
    #[tokio::test]
    async fn invalid_requested_path_falls_back_and_store_errors_propagate() {
        let frozen = tempfile::tempdir().unwrap();
        let registry = SessionRegistry::with_store(
            Arc::new(FakeStore {
                frozen: Some(frozen.path().into()),
                ..Default::default()
            }),
            "dsh",
        );
        assert_eq!(
            registry
                .resolve_cwd("t", Some(frozen.path().join("missing")))
                .await
                .unwrap(),
            frozen.path()
        );
        let failed = SessionRegistry::with_store(
            Arc::new(FakeStore {
                frozen_error: Some("db offline".into()),
                ..Default::default()
            }),
            "dsh",
        );
        assert_eq!(
            failed.resolve_cwd("t", None).await.unwrap_err(),
            "db offline"
        );
    }
    #[tokio::test]
    async fn session_commit_error_is_not_swallowed() {
        let store = Arc::new(FakeStore {
            session_error: Some("commit failed".into()),
            ..Default::default()
        });
        let registry = SessionRegistry::with_store(store.clone(), "dsh");
        assert_eq!(
            registry.commit("t", "s", Path::new(".")).await.unwrap_err(),
            "commit failed"
        );
        assert_eq!(&*store.commits.lock().await, &["cwd", "session"]);
    }
}
