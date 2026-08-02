use super::*;

impl SyncManager {
    pub fn new(api_base: &str, database_path: impl AsRef<Path>) -> Result<Self, SyncError> {
        Ok(Self {
            client: CloudClient::new(api_base)?,
            store: SyncStore::new(database_path)?,
            session: Arc::new(RwLock::new(None)),
            membership: Arc::new(RwLock::new(None)),
            last_error: Arc::new(RwLock::new(None)),
            refresh_lock: Arc::new(tokio::sync::Mutex::new(())),
            account_sync_lock: Arc::new(tokio::sync::Mutex::new(())),
        })
    }

    pub fn store(&self) -> &SyncStore {
        &self.store
    }

    pub fn state(&self) -> Result<CloudState, SyncError> {
        Ok(CloudState {
            enabled: self.store.enabled()?,
            authenticated: self
                .session
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .is_some(),
            account: self.store.v2_account()?,
            membership: self
                .membership
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone(),
            last_error: self
                .last_error
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone(),
        })
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<CloudState, SyncError> {
        self.store.set_enabled(enabled)?;
        self.state()
    }

    /// Returns the currently rotated refresh token for persistence by the
    /// desktop shell. The token must never cross the frontend IPC boundary.
    pub fn current_refresh_token(&self) -> Option<String> {
        self.session
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .map(|session| session.refresh_token.clone())
    }
}
