use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use flowix_core::memo_file::{atomic_write_bytes, MemoFile, NotebookConfig};
use flowix_core::secret::SecretStore;
use flowix_sync::CloudState;
#[cfg(target_os = "ios")]
use tauri_plugin_keyring_store::WriteAccessibility;
use tauri_plugin_keyring_store::{KeyringAvailability, KeyringStore};

const CLOUD_REFRESH_TOKEN_KEY: &str = "flowix_cloud::refresh_token";
const MOBILE_KEYRING_SERVICE: &str = "com.flowix.app.mobile.credentials";

pub struct MobileState {
    pub data_dir: PathBuf,
    pub memo_file: Arc<RwLock<MemoFile>>,
    pub cloud_sync: Arc<flowix_sync::SyncManager>,
    credentials: KeyringStore,
    legacy_secrets: SecretStore,
    cloud_owner_path: PathBuf,
    cloud_owner_user_id: RwLock<Option<String>>,
    pub initialize_lock: tokio::sync::Mutex<()>,
    pub sync_lock: tokio::sync::Mutex<()>,
    mutation_lock: std::sync::Mutex<()>,
}

impl MobileState {
    pub fn new(data_dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
        let config_dir = data_dir.join("config");
        std::fs::create_dir_all(&config_dir).map_err(|error| error.to_string())?;
        let cloud_owner_path = config_dir.join("mobile-cloud-owner.json");
        let cloud_owner_user_id = match std::fs::read_to_string(&cloud_owner_path) {
            Ok(value) => {
                Some(serde_json::from_str::<String>(&value).map_err(|error| error.to_string())?)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.to_string()),
        };
        let cloud_sync = flowix_sync::SyncManager::new(
            flowix_sync::DEFAULT_CLOUD_API_BASE,
            config_dir.join("sync.db"),
        )
        .map_err(|error| error.to_string())?;

        Ok(Self {
            data_dir,
            memo_file: Arc::new(RwLock::new(MemoFile::new(config_dir.clone()))),
            cloud_sync: Arc::new(cloud_sync),
            credentials: mobile_keyring(),
            legacy_secrets: SecretStore::new(config_dir.join("default.db")),
            cloud_owner_path,
            cloud_owner_user_id: RwLock::new(cloud_owner_user_id),
            initialize_lock: tokio::sync::Mutex::new(()),
            sync_lock: tokio::sync::Mutex::new(()),
            mutation_lock: std::sync::Mutex::new(()),
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
        if self.credentials.availability() == KeyringAvailability::Locked {
            return Ok(None);
        }
        if let Some(token) = self
            .credentials
            .get_password_for_background(CLOUD_REFRESH_TOKEN_KEY)
            .map_err(|error| error.to_string())?
        {
            return Ok(Some(token));
        }

        // One-time migration from the pre-mobile-release SQLite credential.
        let legacy = self
            .legacy_secrets
            .load(CLOUD_REFRESH_TOKEN_KEY)
            .map_err(|error| error.to_string())?
            .map(|value| value.into_inner());
        if let Some(token) = legacy.as_deref() {
            self.credentials
                .set_password(CLOUD_REFRESH_TOKEN_KEY, token)
                .map_err(|error| error.to_string())?;
            self.legacy_secrets
                .delete(CLOUD_REFRESH_TOKEN_KEY)
                .map_err(|error| error.to_string())?;
        }
        Ok(legacy)
    }

    pub fn save_refresh_token(&self, token: &str) -> Result<(), String> {
        self.credentials
            .set_password(CLOUD_REFRESH_TOKEN_KEY, token)
            .map_err(|error| error.to_string())?;
        self.legacy_secrets
            .delete(CLOUD_REFRESH_TOKEN_KEY)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    pub fn delete_refresh_token(&self) -> Result<(), String> {
        self.legacy_secrets
            .delete(CLOUD_REFRESH_TOKEN_KEY)
            .map_err(|error| error.to_string())?;
        self.credentials
            .delete(CLOUD_REFRESH_TOKEN_KEY)
            .map_err(|error| error.to_string())
    }

    pub fn persist_rotated_refresh_token(&self) -> Result<(), String> {
        if let Some(token) = self.cloud_sync.current_refresh_token() {
            self.save_refresh_token(&token)?;
        }
        Ok(())
    }

    pub fn ensure_cloud_owner(&self, user_id: &str) -> Result<(), String> {
        let mut current = self
            .cloud_owner_user_id
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if current.as_deref().is_some_and(|owner| owner != user_id) {
            return Err("MOBILE_CLOUD_ACCOUNT_MISMATCH".to_string());
        }
        if current.is_some() {
            return Ok(());
        }
        let encoded = serde_json::to_vec(user_id).map_err(|error| error.to_string())?;
        atomic_write_bytes(&self.cloud_owner_path, &encoded).map_err(|error| error.to_string())?;
        *current = Some(user_id.to_string());
        Ok(())
    }

    /// Removes only the mobile data directory's cloud-account affinity.
    /// Local notebooks remain untouched. Callers must first end the current
    /// cloud session so a deliberate next login can bootstrap those notebooks
    /// into the selected account.
    pub fn clear_cloud_owner(&self) -> Result<(), String> {
        let mut current = self
            .cloud_owner_user_id
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match std::fs::remove_file(&self.cloud_owner_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        *current = None;
        Ok(())
    }

    pub fn lock_mutations(&self) -> std::sync::MutexGuard<'_, ()> {
        self.mutation_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[cfg(test)]
    fn cloud_owner_user_id(&self) -> Option<String> {
        self.cloud_owner_user_id
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

fn mobile_keyring() -> KeyringStore {
    let store = KeyringStore::new(MOBILE_KEYRING_SERVICE);
    #[cfg(target_os = "ios")]
    let store = store.with_write_accessibility(WriteAccessibility::AfterFirstUnlockThisDeviceOnly);
    store
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

    #[test]
    fn pins_cloud_data_to_the_first_account_on_the_device() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let state = MobileState::new(directory.path().to_path_buf()).expect("mobile state");

        state.ensure_cloud_owner("user-a").expect("claim owner");
        state.ensure_cloud_owner("user-a").expect("same owner");
        assert_eq!(state.cloud_owner_user_id().as_deref(), Some("user-a"));
        assert_eq!(
            state.ensure_cloud_owner("user-b").unwrap_err(),
            "MOBILE_CLOUD_ACCOUNT_MISMATCH"
        );

        let restored = MobileState::new(directory.path().to_path_buf()).expect("restored state");
        assert_eq!(restored.cloud_owner_user_id().as_deref(), Some("user-a"));
    }

    #[test]
    fn can_explicitly_clear_the_cloud_owner_without_touching_local_data() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let state = MobileState::new(directory.path().to_path_buf()).expect("mobile state");
        state.ensure_local_notebook().expect("local notebook");
        state.ensure_cloud_owner("user-a").expect("claim owner");

        state.clear_cloud_owner().expect("clear owner");
        assert_eq!(state.cloud_owner_user_id(), None);
        assert!(directory.path().join("notebooks").is_dir());
        state.ensure_cloud_owner("user-b").expect("claim new owner");
    }
}
