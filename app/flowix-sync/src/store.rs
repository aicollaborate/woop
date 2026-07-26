use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::SyncError;
use crate::models::{CloudAccount, NoteState, NotebookLink};

#[derive(Clone)]
pub struct SyncStore {
    path: PathBuf,
}

impl SyncStore {
    pub fn new(path: impl AsRef<Path>) -> Result<Self, SyncError> {
        let store = Self {
            path: path.as_ref().to_path_buf(),
        };
        store.open()?;
        Ok(store)
    }

    fn open(&self) -> Result<Connection, SyncError> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                SyncError::InvalidState(format!("create sync directory: {error}"))
            })?;
        }
        let mut connection = Connection::open(&self.path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            CREATE TABLE IF NOT EXISTS sync_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS cloud_account (
                singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
                payload_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS notebook_links (
                workspace_id TEXT NOT NULL,
                local_notebook_id TEXT NOT NULL,
                cloud_notebook_id TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 0,
                last_cursor INTEGER NOT NULL DEFAULT 0,
                last_sync_at INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(workspace_id, local_notebook_id)
            );
            CREATE TABLE IF NOT EXISTS note_sync_states (
                workspace_id TEXT NOT NULL,
                local_notebook_id TEXT NOT NULL,
                note_id TEXT NOT NULL,
                revision TEXT NOT NULL,
                last_synced_hash TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(workspace_id, local_notebook_id, note_id)
            );
            CREATE TABLE IF NOT EXISTS sync_outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                workspace_id TEXT NOT NULL,
                local_notebook_id TEXT NOT NULL,
                note_id TEXT NOT NULL,
                operation TEXT NOT NULL CHECK(operation IN ('put', 'delete')),
                attempts INTEGER NOT NULL DEFAULT 0,
                next_retry_at INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                UNIQUE(workspace_id, local_notebook_id, note_id)
            );
            "#,
        )?;
        Self::migrate_workspace_scoped_tables(&mut connection)?;
        Ok(connection)
    }

    fn migrate_workspace_scoped_tables(connection: &mut Connection) -> Result<(), SyncError> {
        let workspace_is_link_key = connection
            .query_row(
                "SELECT pk FROM pragma_table_info('notebook_links') WHERE name = 'workspace_id'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0)
            > 0;
        let states_have_workspace = connection
            .query_row(
                "SELECT 1 FROM pragma_table_info('note_sync_states') WHERE name = 'workspace_id'",
                [],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        let outbox_has_workspace = connection
            .query_row(
                "SELECT 1 FROM pragma_table_info('sync_outbox') WHERE name = 'workspace_id'",
                [],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if workspace_is_link_key && states_have_workspace && outbox_has_workspace {
            return Ok(());
        }

        let transaction = connection.transaction()?;
        transaction.execute_batch(
            r#"
            ALTER TABLE notebook_links RENAME TO notebook_links_legacy;
            ALTER TABLE note_sync_states RENAME TO note_sync_states_legacy;
            ALTER TABLE sync_outbox RENAME TO sync_outbox_legacy;

            CREATE TABLE notebook_links (
                workspace_id TEXT NOT NULL,
                local_notebook_id TEXT NOT NULL,
                cloud_notebook_id TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 0,
                last_cursor INTEGER NOT NULL DEFAULT 0,
                last_sync_at INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(workspace_id, local_notebook_id)
            );
            CREATE TABLE note_sync_states (
                workspace_id TEXT NOT NULL,
                local_notebook_id TEXT NOT NULL,
                note_id TEXT NOT NULL,
                revision TEXT NOT NULL,
                last_synced_hash TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(workspace_id, local_notebook_id, note_id)
            );
            CREATE TABLE sync_outbox (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                workspace_id TEXT NOT NULL,
                local_notebook_id TEXT NOT NULL,
                note_id TEXT NOT NULL,
                operation TEXT NOT NULL CHECK(operation IN ('put', 'delete')),
                attempts INTEGER NOT NULL DEFAULT 0,
                next_retry_at INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                UNIQUE(workspace_id, local_notebook_id, note_id)
            );

            INSERT INTO notebook_links
                (workspace_id, local_notebook_id, cloud_notebook_id, enabled,
                 last_cursor, last_sync_at, created_at, updated_at)
            SELECT workspace_id, local_notebook_id, cloud_notebook_id, enabled,
                   last_cursor, last_sync_at, created_at, updated_at
              FROM notebook_links_legacy;

            INSERT INTO note_sync_states
                (workspace_id, local_notebook_id, note_id, revision,
                 last_synced_hash, updated_at)
            SELECT links.workspace_id, states.local_notebook_id, states.note_id,
                   states.revision, states.last_synced_hash, states.updated_at
              FROM note_sync_states_legacy states
              JOIN notebook_links_legacy links
                ON links.local_notebook_id = states.local_notebook_id;

            INSERT INTO sync_outbox
                (id, workspace_id, local_notebook_id, note_id, operation,
                 attempts, next_retry_at, created_at)
            SELECT outbox.id, links.workspace_id, outbox.local_notebook_id,
                   outbox.note_id, outbox.operation, outbox.attempts,
                   outbox.next_retry_at, outbox.created_at
              FROM sync_outbox_legacy outbox
              JOIN notebook_links_legacy links
                ON links.local_notebook_id = outbox.local_notebook_id;

            DROP TABLE sync_outbox_legacy;
            DROP TABLE note_sync_states_legacy;
            DROP TABLE notebook_links_legacy;
            "#,
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn enabled(&self) -> Result<bool, SyncError> {
        let value = self
            .open()?
            .query_row(
                "SELECT value FROM sync_settings WHERE key = 'enabled'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(value.as_deref() == Some("true"))
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<(), SyncError> {
        self.open()?.execute(
            r#"INSERT INTO sync_settings(key, value) VALUES ('enabled', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value"#,
            [if enabled { "true" } else { "false" }],
        )?;
        Ok(())
    }

    pub fn account(&self) -> Result<Option<CloudAccount>, SyncError> {
        let payload = self
            .open()?
            .query_row(
                "SELECT payload_json FROM cloud_account WHERE singleton = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        payload
            .map(|value| {
                serde_json::from_str(&value).map_err(|error| {
                    SyncError::InvalidState(format!("invalid stored cloud account: {error}"))
                })
            })
            .transpose()
    }

    pub fn save_account(&self, account: &CloudAccount) -> Result<(), SyncError> {
        self.open()?.execute(
            r#"INSERT INTO cloud_account(singleton, payload_json, updated_at) VALUES (1, ?1, ?2)
             ON CONFLICT(singleton) DO UPDATE SET
               payload_json = excluded.payload_json, updated_at = excluded.updated_at"#,
            params![
                serde_json::to_string(account).map_err(|error| {
                    SyncError::InvalidState(format!("serialize cloud account: {error}"))
                })?,
                chrono::Utc::now().timestamp_millis()
            ],
        )?;
        Ok(())
    }

    pub fn clear_account(&self) -> Result<(), SyncError> {
        self.open()?.execute("DELETE FROM cloud_account", [])?;
        Ok(())
    }

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CloudAccount, CloudUser, CloudWorkspace};

    #[test]
    fn settings_account_and_notebook_links_round_trip() {
        let temp = tempfile::tempdir().unwrap();
        let store = SyncStore::new(temp.path().join("sync.db")).unwrap();
        assert!(!store.enabled().unwrap());
        store.set_enabled(true).unwrap();
        assert!(store.enabled().unwrap());

        let account = CloudAccount {
            user: CloudUser {
                id: "usr_1".into(),
                email: "a@example.com".into(),
                display_name: "A".into(),
                system_role: "user".into(),
            },
            workspace: CloudWorkspace {
                id: "ws_1".into(),
                name: Some("A".into()),
                slug: "a".into(),
                role: "owner".into(),
                kind: Some("personal".into()),
            },
        };
        store.save_account(&account).unwrap();
        assert_eq!(store.account().unwrap(), Some(account));

        let link = store
            .set_notebook("nb_1", "ws_1", "cloud_nb_1", true)
            .unwrap();
        assert!(link.enabled);
        assert_eq!(link.cloud_notebook_id, "cloud_nb_1");
        assert_eq!(store.enabled_notebooks("ws_1").unwrap().len(), 1);
        store.disable_notebook("ws_1", "nb_1").unwrap();
        assert!(store.enabled_notebooks("ws_1").unwrap().is_empty());
        store.forget_notebook("nb_1").unwrap();
        assert_eq!(store.notebook_link("ws_1", "nb_1").unwrap(), None);
    }

    #[test]
    fn sync_state_is_isolated_by_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let store = SyncStore::new(temp.path().join("sync.db")).unwrap();
        store
            .set_notebook("nb_shared", "ws_1", "cloud_nb_1", true)
            .unwrap();
        store
            .set_notebook("nb_shared", "ws_2", "cloud_nb_2", true)
            .unwrap();
        store
            .save_note_state("ws_1", "nb_shared", "note_1", "rev_1", "hash_1")
            .unwrap();
        store
            .save_note_state("ws_2", "nb_shared", "note_1", "rev_2", "hash_2")
            .unwrap();

        assert_eq!(
            store
                .note_state("ws_1", "nb_shared", "note_1")
                .unwrap()
                .unwrap()
                .revision,
            "rev_1"
        );
        assert_eq!(
            store
                .note_state("ws_2", "nb_shared", "note_1")
                .unwrap()
                .unwrap()
                .revision,
            "rev_2"
        );
        assert_eq!(store.enabled_notebooks("ws_1").unwrap().len(), 1);
        assert_eq!(store.enabled_notebooks("ws_2").unwrap().len(), 1);

        store.finish_sync("ws_1", "nb_shared", 42).unwrap();
        assert_eq!(
            store
                .notebook_link("ws_1", "nb_shared")
                .unwrap()
                .unwrap()
                .last_cursor,
            42
        );
        assert_eq!(
            store
                .notebook_link("ws_2", "nb_shared")
                .unwrap()
                .unwrap()
                .last_cursor,
            0
        );
    }

    #[test]
    fn explicit_remote_link_resets_only_that_workspace_state() {
        let temp = tempfile::tempdir().unwrap();
        let store = SyncStore::new(temp.path().join("sync.db")).unwrap();
        store
            .set_notebook("nb_shared", "ws_1", "cloud_old", true)
            .unwrap();
        store
            .set_notebook("nb_shared", "ws_2", "cloud_other", true)
            .unwrap();
        store
            .save_note_state("ws_1", "nb_shared", "note_1", "rev_1", "hash_1")
            .unwrap();
        store
            .save_note_state("ws_2", "nb_shared", "note_1", "rev_2", "hash_2")
            .unwrap();
        store.finish_sync("ws_1", "nb_shared", 25).unwrap();

        let link = store
            .link_remote_notebook("ws_1", "nb_shared", "cloud_new")
            .unwrap();

        assert_eq!(link.cloud_notebook_id, "cloud_new");
        assert_eq!(link.last_cursor, 0);
        assert!(link.last_sync_at.is_none());
        assert!(store
            .note_state("ws_1", "nb_shared", "note_1")
            .unwrap()
            .is_none());
        assert_eq!(
            store
                .note_state("ws_2", "nb_shared", "note_1")
                .unwrap()
                .unwrap()
                .revision,
            "rev_2"
        );
    }

    #[test]
    fn migrates_legacy_sync_state_into_its_workspace() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("sync.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                r#"
                CREATE TABLE notebook_links (
                    local_notebook_id TEXT PRIMARY KEY,
                    workspace_id TEXT NOT NULL,
                    cloud_notebook_id TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 0,
                    last_cursor INTEGER NOT NULL DEFAULT 0,
                    last_sync_at INTEGER,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE note_sync_states (
                    local_notebook_id TEXT NOT NULL,
                    note_id TEXT NOT NULL,
                    revision TEXT NOT NULL,
                    last_synced_hash TEXT NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY(local_notebook_id, note_id)
                );
                CREATE TABLE sync_outbox (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    local_notebook_id TEXT NOT NULL,
                    note_id TEXT NOT NULL,
                    operation TEXT NOT NULL CHECK(operation IN ('put', 'delete')),
                    attempts INTEGER NOT NULL DEFAULT 0,
                    next_retry_at INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL,
                    UNIQUE(local_notebook_id, note_id)
                );
                INSERT INTO notebook_links VALUES
                    ('nb_1', 'ws_legacy', 'cloud_nb_1', 1, 9, NULL, 1, 1);
                INSERT INTO note_sync_states VALUES
                    ('nb_1', 'note_1', 'rev_legacy', 'hash_legacy', 1);
                INSERT INTO sync_outbox
                    (local_notebook_id, note_id, operation, created_at)
                VALUES ('nb_1', 'note_1', 'put', 1);
                "#,
            )
            .unwrap();
        drop(connection);

        let store = SyncStore::new(&path).unwrap();
        assert_eq!(
            store
                .notebook_link("ws_legacy", "nb_1")
                .unwrap()
                .unwrap()
                .last_cursor,
            9
        );
        assert_eq!(
            store
                .note_state("ws_legacy", "nb_1", "note_1")
                .unwrap()
                .unwrap()
                .revision,
            "rev_legacy"
        );
    }
}
