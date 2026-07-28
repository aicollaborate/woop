use super::*;

impl SyncStore {
    pub(crate) fn enqueue_outbox(
        &self,
        workspace_id: &str,
        notebook_id: &str,
        note_id: &str,
        operation: LocalChangeKind,
        occurred_at: i64,
        logical_counter: i64,
        device_id: &str,
    ) -> Result<(), SyncError> {
        self.open()?.execute(
            r#"INSERT OR REPLACE INTO sync_outbox
                  (workspace_id, local_notebook_id, note_id, operation,
                  attempts, next_retry_at, created_at, logical_counter, device_id)
               VALUES (?1, ?2, ?3, ?4, 0, 0, ?5, ?6, ?7)"#,
            params![
                workspace_id,
                notebook_id,
                note_id,
                operation.as_str(),
                occurred_at,
                logical_counter,
                device_id
            ],
        )?;
        Ok(())
    }

    pub(crate) fn outbox(
        &self,
        workspace_id: &str,
        notebook_id: &str,
    ) -> Result<Vec<OutboxEntry>, SyncError> {
        let connection = self.open()?;
        let mut statement = connection.prepare(
            r#"SELECT id, note_id, operation, created_at,
                      logical_counter, device_id
                 FROM sync_outbox
                WHERE workspace_id = ?1 AND local_notebook_id = ?2
                ORDER BY created_at, id"#,
        )?;
        let rows = statement.query_map(params![workspace_id, notebook_id], |row| {
            let operation: String = row.get(2)?;
            Ok(OutboxEntry {
                id: row.get(0)?,
                note_id: row.get(1)?,
                operation: if operation == "delete" {
                    LocalChangeKind::Delete
                } else {
                    LocalChangeKind::Put
                },
                occurred_at: row.get(3)?,
                logical_counter: row.get(4)?,
                device_id: row.get(5)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(SyncError::from)
    }

    pub(crate) fn retry_due_at(
        &self,
        workspace_id: &str,
        notebook_id: &str,
    ) -> Result<Option<i64>, SyncError> {
        self.open()?
            .query_row(
                r#"SELECT MAX(next_retry_at) FROM sync_outbox
                    WHERE workspace_id = ?1 AND local_notebook_id = ?2"#,
                params![workspace_id, notebook_id],
                |row| row.get(0),
            )
            .map_err(SyncError::from)
    }

    pub(crate) fn defer_outbox_retry(
        &self,
        workspace_id: &str,
        notebook_id: &str,
        now: i64,
    ) -> Result<Option<i64>, SyncError> {
        let connection = self.open()?;
        let attempts = connection
            .query_row(
                r#"SELECT MAX(attempts) FROM sync_outbox
                    WHERE workspace_id = ?1 AND local_notebook_id = ?2"#,
                params![workspace_id, notebook_id],
                |row| row.get::<_, Option<i64>>(0),
            )?
            .unwrap_or(-1)
            + 1;
        if attempts <= 0 {
            return Ok(None);
        }
        let base_ms = match attempts {
            1 => 5_000,
            2 => 15_000,
            3 => 60_000,
            4 => 300_000,
            _ => 1_800_000,
        };
        // Deterministic 0-20% jitter prevents several devices from retrying
        // the same workspace at exactly the same instant.
        let jitter = (now.unsigned_abs() % (base_ms as u64 / 5 + 1)) as i64;
        let retry_at = now.saturating_add(base_ms).saturating_add(jitter);
        connection.execute(
            r#"UPDATE sync_outbox
                  SET attempts = attempts + 1, next_retry_at = ?3
                WHERE workspace_id = ?1 AND local_notebook_id = ?2"#,
            params![workspace_id, notebook_id, retry_at],
        )?;
        Ok(Some(retry_at))
    }

    pub(crate) fn clear_outbox_through(
        &self,
        workspace_id: &str,
        notebook_id: &str,
        through_id: i64,
    ) -> Result<(), SyncError> {
        self.open()?.execute(
            r#"DELETE FROM sync_outbox
                WHERE workspace_id = ?1 AND local_notebook_id = ?2
                  AND id <= ?3"#,
            params![workspace_id, notebook_id, through_id],
        )?;
        Ok(())
    }

    pub(crate) fn finish_sync(
        &self,
        workspace_id: &str,
        notebook_id: &str,
        cursor: i64,
    ) -> Result<(), SyncError> {
        self.open()?.execute(
            r#"UPDATE notebook_links SET last_cursor = ?3, last_sync_at = ?4, updated_at = ?4
              WHERE workspace_id = ?1 AND local_notebook_id = ?2"#,
            params![
                workspace_id,
                notebook_id,
                cursor,
                chrono::Utc::now().timestamp_millis()
            ],
        )?;
        Ok(())
    }
}
