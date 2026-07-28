use super::*;

impl SyncStore {
    pub fn notebook_link(
        &self,
        workspace_id: &str,
        notebook_id: &str,
    ) -> Result<Option<NotebookLink>, SyncError> {
        self.open()?
            .query_row(
                r#"SELECT local_notebook_id, workspace_id, cloud_notebook_id,
                        enabled, last_cursor, last_sync_at
                   FROM notebook_links
                  WHERE workspace_id = ?1 AND local_notebook_id = ?2"#,
                params![workspace_id, notebook_id],
                |row| {
                    Ok(NotebookLink {
                        local_notebook_id: row.get(0)?,
                        workspace_id: row.get(1)?,
                        cloud_notebook_id: row.get(2)?,
                        enabled: row.get::<_, i64>(3)? != 0,
                        last_cursor: row.get(4)?,
                        last_sync_at: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub(crate) fn cloud_notebook_is_linked(
        &self,
        workspace_id: &str,
        cloud_notebook_id: &str,
    ) -> Result<bool, SyncError> {
        let found = self
            .open()?
            .query_row(
                "SELECT 1 FROM notebook_links
                  WHERE workspace_id = ?1 AND cloud_notebook_id = ?2 LIMIT 1",
                params![workspace_id, cloud_notebook_id],
                |_| Ok(true),
            )
            .optional()?;
        Ok(found.unwrap_or(false))
    }

    pub fn enabled_notebooks(&self, workspace_id: &str) -> Result<Vec<NotebookLink>, SyncError> {
        let connection = self.open()?;
        let mut statement = connection.prepare(
            r#"SELECT local_notebook_id, workspace_id, cloud_notebook_id,
                    enabled, last_cursor, last_sync_at
               FROM notebook_links
              WHERE workspace_id = ?1 AND enabled = 1
              ORDER BY created_at"#,
        )?;
        let rows = statement.query_map([workspace_id], |row| {
            Ok(NotebookLink {
                local_notebook_id: row.get(0)?,
                workspace_id: row.get(1)?,
                cloud_notebook_id: row.get(2)?,
                enabled: row.get::<_, i64>(3)? != 0,
                last_cursor: row.get(4)?,
                last_sync_at: row.get(5)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn set_notebook(
        &self,
        notebook_id: &str,
        workspace_id: &str,
        cloud_notebook_id: &str,
        enabled: bool,
    ) -> Result<NotebookLink, SyncError> {
        let now = chrono::Utc::now().timestamp_millis();
        self.open()?.execute(
            r#"INSERT INTO notebook_links
              (workspace_id, local_notebook_id, cloud_notebook_id, enabled,
               last_cursor, created_at, updated_at)
             VALUES (?2, ?1, ?3, ?4, 0, ?5, ?5)
             ON CONFLICT(workspace_id, local_notebook_id) DO UPDATE SET
               cloud_notebook_id = excluded.cloud_notebook_id,
               enabled = excluded.enabled,
               updated_at = excluded.updated_at"#,
            params![
                notebook_id,
                workspace_id,
                cloud_notebook_id,
                i64::from(enabled),
                now
            ],
        )?;
        self.notebook_link(workspace_id, notebook_id)?
            .ok_or_else(|| SyncError::InvalidState("notebook link was not saved".into()))
    }

    pub fn link_remote_notebook(
        &self,
        workspace_id: &str,
        notebook_id: &str,
        cloud_notebook_id: &str,
    ) -> Result<NotebookLink, SyncError> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "DELETE FROM note_sync_states
              WHERE workspace_id = ?1 AND local_notebook_id = ?2",
            params![workspace_id, notebook_id],
        )?;
        transaction.execute(
            "DELETE FROM sync_outbox
              WHERE workspace_id = ?1 AND local_notebook_id = ?2",
            params![workspace_id, notebook_id],
        )?;
        transaction.execute(
            r#"INSERT INTO notebook_links
              (workspace_id, local_notebook_id, cloud_notebook_id, enabled,
               last_cursor, last_sync_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, 1, 0, NULL, ?4, ?4)
             ON CONFLICT(workspace_id, local_notebook_id) DO UPDATE SET
               cloud_notebook_id = excluded.cloud_notebook_id,
               enabled = 1,
               last_cursor = 0,
               last_sync_at = NULL,
               updated_at = excluded.updated_at"#,
            params![workspace_id, notebook_id, cloud_notebook_id, now],
        )?;
        transaction.commit()?;
        self.notebook_link(workspace_id, notebook_id)?
            .ok_or_else(|| SyncError::InvalidState("remote notebook link was not saved".into()))
    }

    pub fn disable_notebook(&self, workspace_id: &str, notebook_id: &str) -> Result<(), SyncError> {
        self.open()?.execute(
            "UPDATE notebook_links SET enabled = 0, updated_at = ?3
              WHERE workspace_id = ?1 AND local_notebook_id = ?2",
            params![
                workspace_id,
                notebook_id,
                chrono::Utc::now().timestamp_millis()
            ],
        )?;
        Ok(())
    }

    pub fn forget_notebook(&self, notebook_id: &str) -> Result<(), SyncError> {
        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "DELETE FROM note_sync_states WHERE local_notebook_id = ?1",
            [notebook_id],
        )?;
        transaction.execute(
            "DELETE FROM sync_outbox WHERE local_notebook_id = ?1",
            [notebook_id],
        )?;
        transaction.execute(
            "DELETE FROM notebook_links WHERE local_notebook_id = ?1",
            [notebook_id],
        )?;
        transaction.commit()?;
        Ok(())
    }
}
