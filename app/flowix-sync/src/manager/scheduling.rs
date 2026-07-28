use super::*;

impl SyncManager {
    pub fn notebook_link(&self, notebook_id: &str) -> Result<Option<NotebookLink>, SyncError> {
        let Some(account) = self.store.account()? else {
            return Ok(None);
        };
        self.store.notebook_link(&account.workspace.id, notebook_id)
    }

    pub fn enabled_notebooks(&self) -> Result<Vec<NotebookLink>, SyncError> {
        let Some(account) = self.store.account()? else {
            return Ok(Vec::new());
        };
        self.store.enabled_notebooks(&account.workspace.id)
    }

    pub fn record_local_change(
        &self,
        notebook_id: &str,
        note_id: &str,
        operation: LocalChangeKind,
    ) -> Result<(), SyncError> {
        let Some(account) = self.store.account()? else {
            return Ok(());
        };
        let Some(link) = self
            .store
            .notebook_link(&account.workspace.id, notebook_id)?
            .filter(|link| link.enabled)
        else {
            return Ok(());
        };
        let occurred_at = Utc::now()
            .timestamp_millis()
            .saturating_add(self.store.server_time_offset()?);
        self.store.enqueue_outbox(
            &link.workspace_id,
            notebook_id,
            note_id,
            operation,
            occurred_at,
            self.store.next_logical_counter()?,
            &self.store.device_id()?,
        )
    }

    pub fn automatic_sync_due(&self, notebook_id: &str, now: i64) -> Result<bool, SyncError> {
        let Some(account) = self.store.account()? else {
            return Ok(false);
        };
        let Some(link) = self
            .store
            .notebook_link(&account.workspace.id, notebook_id)?
            .filter(|link| link.enabled)
        else {
            return Ok(false);
        };
        Ok(self
            .store
            .retry_due_at(&link.workspace_id, notebook_id)?
            .is_none_or(|retry_at| retry_at <= now))
    }

    pub fn defer_notebook_retry(&self, notebook_id: &str) -> Result<Option<i64>, SyncError> {
        let Some(account) = self.store.account()? else {
            return Ok(None);
        };
        let Some(link) = self
            .store
            .notebook_link(&account.workspace.id, notebook_id)?
            .filter(|link| link.enabled)
        else {
            return Ok(None);
        };
        let now = Utc::now().timestamp_millis();
        Ok(self
            .store
            .defer_outbox_retry(&link.workspace_id, notebook_id, now)?
            .map(|retry_at| retry_at.saturating_sub(now)))
    }

    pub fn has_pending_local_changes(&self, notebook_id: &str) -> Result<bool, SyncError> {
        let Some(account) = self.store.account()? else {
            return Ok(false);
        };
        let Some(link) = self
            .store
            .notebook_link(&account.workspace.id, notebook_id)?
            .filter(|link| link.enabled)
        else {
            return Ok(false);
        };
        Ok(!self
            .store
            .outbox(&link.workspace_id, notebook_id)?
            .is_empty())
    }

    pub async fn notebook_needs_sync(&self, notebook_id: &str) -> Result<bool, SyncError> {
        if self.has_pending_local_changes(notebook_id)? {
            return Ok(true);
        }
        let account = self.store.account()?.ok_or(SyncError::NotAuthenticated)?;
        let link = self
            .store
            .notebook_link(&account.workspace.id, notebook_id)?
            .filter(|link| link.enabled)
            .ok_or(SyncError::NotebookDisabled)?;
        let token = self.access_token().await?;
        match self
            .client
            .sync_status(&token, &link.workspace_id, link.last_cursor)
            .await
        {
            Ok(status) => {
                if let Some(server_time) = status.server_time {
                    self.store
                        .observe_server_time(server_time, Utc::now().timestamp_millis())?;
                }
                Ok(status.has_changes || status.head_cursor > link.last_cursor)
            }
            // During a staged rollout an older Cloud deployment may not expose
            // the lightweight endpoint yet. Fall back to a full sync instead
            // of breaking synchronization.
            Err(SyncError::Api { status: 404, .. }) => Ok(true),
            Err(error) => Err(error),
        }
    }

    pub fn disable_notebook(&self, notebook_id: &str) -> Result<(), SyncError> {
        let account = self.store.account()?.ok_or(SyncError::NotAuthenticated)?;
        self.store
            .disable_notebook(&account.workspace.id, notebook_id)
    }

    pub fn forget_notebook(&self, notebook_id: &str) -> Result<(), SyncError> {
        self.store.forget_notebook(notebook_id)
    }
}
