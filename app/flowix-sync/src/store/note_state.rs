use super::*;

impl SyncStore {
    pub(crate) fn note_state(
        &self,
        workspace_id: &str,
        notebook_id: &str,
        note_id: &str,
    ) -> Result<Option<NoteState>, SyncError> {
        self.open()?
            .query_row(
                r#"SELECT revision, last_synced_hash FROM note_sync_states
                  WHERE workspace_id = ?1 AND local_notebook_id = ?2 AND note_id = ?3"#,
                params![workspace_id, notebook_id, note_id],
                |row| {
                    Ok(NoteState {
                        revision: row.get(0)?,
                        last_synced_hash: row.get(1)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub(crate) fn note_states(
        &self,
        workspace_id: &str,
        notebook_id: &str,
    ) -> Result<Vec<(String, NoteState)>, SyncError> {
        let connection = self.open()?;
        let mut statement = connection.prepare(
            "SELECT note_id, revision, last_synced_hash
               FROM note_sync_states
              WHERE workspace_id = ?1 AND local_notebook_id = ?2",
        )?;
        let rows = statement.query_map(params![workspace_id, notebook_id], |row| {
            Ok((
                row.get(0)?,
                NoteState {
                    revision: row.get(1)?,
                    last_synced_hash: row.get(2)?,
                },
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub(crate) fn save_note_state(
        &self,
        workspace_id: &str,
        notebook_id: &str,
        note_id: &str,
        revision: &str,
        hash: &str,
    ) -> Result<(), SyncError> {
        self.open()?.execute(
            r#"INSERT INTO note_sync_states
              (workspace_id, local_notebook_id, note_id, revision,
               last_synced_hash, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(workspace_id, local_notebook_id, note_id) DO UPDATE SET
               revision = excluded.revision,
               last_synced_hash = excluded.last_synced_hash,
               updated_at = excluded.updated_at"#,
            params![
                workspace_id,
                notebook_id,
                note_id,
                revision,
                hash,
                chrono::Utc::now().timestamp_millis()
            ],
        )?;
        Ok(())
    }

    pub(crate) fn remove_note_state(
        &self,
        workspace_id: &str,
        notebook_id: &str,
        note_id: &str,
    ) -> Result<(), SyncError> {
        self.open()?.execute(
            "DELETE FROM note_sync_states
              WHERE workspace_id = ?1 AND local_notebook_id = ?2 AND note_id = ?3",
            params![workspace_id, notebook_id, note_id],
        )?;
        Ok(())
    }
}
