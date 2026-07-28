use super::*;

impl SyncStore {
    pub fn new(path: impl AsRef<Path>) -> Result<Self, SyncError> {
        let store = Self {
            path: path.as_ref().to_path_buf(),
        };
        store.open()?;
        Ok(store)
    }

    pub(super) fn open(&self) -> Result<Connection, SyncError> {
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
                logical_counter INTEGER NOT NULL DEFAULT 0,
                device_id TEXT NOT NULL DEFAULT '',
                UNIQUE(workspace_id, local_notebook_id, note_id)
            );
            "#,
        )?;
        Self::migrate_workspace_scoped_tables(&mut connection)?;
        Self::migrate_outbox_version_columns(&connection)?;
        Ok(connection)
    }

    fn migrate_outbox_version_columns(connection: &Connection) -> Result<(), SyncError> {
        let has_counter = connection
            .query_row(
                "SELECT 1 FROM pragma_table_info('sync_outbox') WHERE name = 'logical_counter'",
                [],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !has_counter {
            connection.execute(
                "ALTER TABLE sync_outbox ADD COLUMN logical_counter INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        let has_device = connection
            .query_row(
                "SELECT 1 FROM pragma_table_info('sync_outbox') WHERE name = 'device_id'",
                [],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !has_device {
            connection.execute(
                "ALTER TABLE sync_outbox ADD COLUMN device_id TEXT NOT NULL DEFAULT ''",
                [],
            )?;
        }
        Ok(())
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
                logical_counter INTEGER NOT NULL DEFAULT 0,
                device_id TEXT NOT NULL DEFAULT '',
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
                 attempts, next_retry_at, created_at, logical_counter, device_id)
            SELECT outbox.id, links.workspace_id, outbox.local_notebook_id,
                   outbox.note_id, outbox.operation, outbox.attempts,
                   outbox.next_retry_at, outbox.created_at, 0, ''
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
}
