use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Clone)]
pub(crate) struct PluginRunCoordinator {
    runs: Arc<Mutex<HashMap<String, PluginRunInfo>>>,
}

#[derive(Clone)]
pub(crate) struct PluginRunInfo {
    pub(crate) plugin_id: String,
    pub(crate) agent_type: String,
    pub(crate) thread_id: Option<String>,
    state: PluginRunState,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PluginRunState {
    Running,
    Finishing,
}

impl Default for PluginRunCoordinator {
    fn default() -> Self {
        Self {
            runs: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl PluginRunCoordinator {
    pub(crate) async fn try_reserve(
        &self,
        run_id: String,
        plugin_id: String,
        agent_type: String,
    ) -> bool {
        let mut runs = self.runs.lock().await;
        if runs.values().any(|info| info.plugin_id == plugin_id) {
            return false;
        }
        runs.insert(
            run_id,
            PluginRunInfo {
                plugin_id,
                agent_type,
                thread_id: None,
                state: PluginRunState::Running,
            },
        );
        true
    }

    pub(crate) async fn attach_thread(&self, run_id: &str, thread_id: String) -> bool {
        let mut runs = self.runs.lock().await;
        let Some(info) = runs.get_mut(run_id) else {
            return false;
        };
        if info.state != PluginRunState::Running || info.thread_id.is_some() {
            return false;
        }
        info.thread_id = Some(thread_id);
        true
    }

    pub(crate) async fn remove(&self, run_id: &str) -> Option<PluginRunInfo> {
        self.runs.lock().await.remove(run_id)
    }

    pub(crate) async fn thread_id(&self, run_id: &str) -> Option<String> {
        self.runs
            .lock()
            .await
            .get(run_id)
            .and_then(|info| info.thread_id.clone())
    }

    pub(crate) async fn begin_finish(&self, run_id: &str) -> Option<PluginRunInfo> {
        let mut runs = self.runs.lock().await;
        let info = runs.get_mut(run_id)?;
        if info.state != PluginRunState::Running {
            return None;
        }
        info.state = PluginRunState::Finishing;
        Some(info.clone())
    }

    pub(crate) async fn cancel(&self, run_id: &str) -> Option<PluginRunInfo> {
        let mut runs = self.runs.lock().await;
        if !runs
            .get(run_id)
            .is_some_and(|info| info.state == PluginRunState::Running)
        {
            return None;
        }
        runs.remove(run_id)
    }
}

#[cfg(test)]
mod tests {
    use super::PluginRunCoordinator;

    #[tokio::test]
    async fn reserves_one_run_per_plugin_and_releases_it() {
        let coordinator = PluginRunCoordinator::default();
        assert!(
            coordinator
                .try_reserve("a".into(), "mindmap".into(), "flowix".into())
                .await
        );
        assert!(
            !coordinator
                .try_reserve("b".into(), "mindmap".into(), "flowix".into())
                .await
        );
        assert!(coordinator.cancel("a").await.is_some());
        assert!(
            coordinator
                .try_reserve("b".into(), "mindmap".into(), "flowix".into())
                .await
        );
    }

    #[tokio::test]
    async fn only_one_terminal_transition_wins() {
        let coordinator = PluginRunCoordinator::default();
        coordinator
            .try_reserve("a".into(), "mindmap".into(), "flowix".into())
            .await;
        assert!(coordinator.begin_finish("a").await.is_some());
        assert!(coordinator.begin_finish("a").await.is_none());
        assert!(coordinator.cancel("a").await.is_none());
    }
}
