use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use flowix_core::memo_file::{MemoFile, NotebookConfig};
use flowix_core::secret::SecretStore;
use flowix_sync::CloudState;

const CLOUD_REFRESH_TOKEN_KEY: &str = "flowix_cloud::refresh_token";

pub struct MobileState {
    pub data_dir: PathBuf,
    pub memo_file: Arc<RwLock<MemoFile>>,
    pub cloud_sync: Arc<flowix_sync::SyncManager>,
    secrets: SecretStore,
    pub initialize_lock: tokio::sync::Mutex<()>,
    pub sync_lock: tokio::sync::Mutex<()>,
}

impl MobileState {
    pub fn new(data_dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
        let config_dir = data_dir.join("config");
        std::fs::create_dir_all(&config_dir).map_err(|error| error.to_string())?;
        let cloud_sync = flowix_sync::SyncManager::new(
            flowix_sync::DEFAULT_CLOUD_API_BASE,
            config_dir.join("sync.db"),
        )
        .map_err(|error| error.to_string())?;

        Ok(Self {
            data_dir,
            memo_file: Arc::new(RwLock::new(MemoFile::new(config_dir.clone()))),
            cloud_sync: Arc::new(cloud_sync),
            secrets: SecretStore::new(config_dir.join("default.db")),
            initialize_lock: tokio::sync::Mutex::new(()),
            sync_lock: tokio::sync::Mutex::new(()),
        })
    }

    pub fn notebook_dir(&self, notebook_id: &str) -> PathBuf {
        self.data_dir.join("notebooks").join(notebook_id)
    }

    pub fn ensure_local_notebook(&self) -> Result<(), String> {
        let memo_file = read_memo_file(self);
        let configs = memo_file
            .read_notebook_configs()
            .map_err(|error| error.to_string())?;
        if !configs.is_empty() {
            return Ok(());
        }

        let id = format!("nb_{}", uuid::Uuid::now_v7());
        let path = self.notebook_dir(&id);
        std::fs::create_dir_all(&path).map_err(|error| error.to_string())?;
        let now = chrono::Utc::now().timestamp_millis();
        memo_file
            .write_notebook_configs(&[NotebookConfig {
                id,
                name: "我的笔记".to_string(),
                icon: Some("📝".to_string()),
                path: format!("{}/", path.display()),
                is_default: true,
                sort: 10,
                created_at: now,
                updated_at: now,
            }])
            .map_err(|error| error.to_string())
    }

    pub fn load_refresh_token(&self) -> Result<Option<String>, String> {
        self.secrets
            .load(CLOUD_REFRESH_TOKEN_KEY)
            .map(|token| token.map(|value| value.into_inner()))
            .map_err(|error| error.to_string())
    }

    pub fn save_refresh_token(&self, token: &str) -> Result<(), String> {
        self.secrets
            .save(CLOUD_REFRESH_TOKEN_KEY, token)
            .map_err(|error| error.to_string())
    }

    pub fn delete_refresh_token(&self) -> Result<(), String> {
        self.secrets
            .delete(CLOUD_REFRESH_TOKEN_KEY)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub fn persist_rotated_refresh_token(&self) -> Result<(), String> {
        if let Some(token) = self.cloud_sync.current_refresh_token() {
            self.save_refresh_token(&token)?;
        }
        Ok(())
    }
}

pub fn cloud_sync_allowed(state: &CloudState) -> bool {
    state.authenticated
        && state
            .membership
            .as_ref()
            .is_some_and(|membership| membership.active && !membership.read_only)
}

pub fn read_memo_file(state: &MobileState) -> std::sync::RwLockReadGuard<'_, MemoFile> {
    state
        .memo_file
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use flowix_sync::{CloudMembership, CloudState};

    use super::{cloud_sync_allowed, MobileState};

    fn cloud_state(active: bool, read_only: bool) -> CloudState {
        CloudState {
            enabled: false,
            authenticated: true,
            account: None,
            membership: Some(CloudMembership {
                active,
                starts_at: None,
                expires_at: None,
                used_bytes: 0,
                quota_bytes: 1024,
                available_bytes: 1024,
                note_count: 0,
                read_only,
            }),
            last_error: None,
        }
    }

    #[test]
    fn creates_one_private_local_notebook() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let state = MobileState::new(directory.path().to_path_buf()).expect("mobile state");

        state.ensure_local_notebook().expect("first initialization");
        state
            .ensure_local_notebook()
            .expect("second initialization");

        let configs = super::read_memo_file(&state)
            .read_notebook_configs()
            .expect("notebook configs");
        assert_eq!(configs.len(), 1);
        assert_eq!(configs[0].name, "我的笔记");
        assert!(std::path::Path::new(&configs[0].path).is_dir());
    }

    #[test]
    fn only_active_writable_memberships_can_sync() {
        assert!(cloud_sync_allowed(&cloud_state(true, false)));
        assert!(!cloud_sync_allowed(&cloud_state(false, false)));
        assert!(!cloud_sync_allowed(&cloud_state(true, true)));

        let mut logged_out = cloud_state(true, false);
        logged_out.authenticated = false;
        assert!(!cloud_sync_allowed(&logged_out));
    }
}
