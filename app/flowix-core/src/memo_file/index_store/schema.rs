use super::*;

impl MemoFile {
    pub fn storage_title_from_filename(filename: &str) -> String {
        let stem = filename.strip_suffix(".md").unwrap_or(filename).to_string();
        let safe_title = Self::sanitize_memo_filename_component(&stem);
        if safe_title.is_empty() {
            chrono::Local::now().format("untitled-%Y-%m-%d").to_string()
        } else {
            safe_title
        }
    }

    pub(crate) fn current_notebook_id_for_index(&self) -> String {
        self.current_notebook_id_value()
            .or_else(|| {
                self.read_notebook_configs()
                    .ok()
                    .and_then(|configs| configs.into_iter().next())
                    .map(|cfg| cfg.id)
            })
            .unwrap_or_else(|| "nb_default".to_string())
    }

    pub(super) fn notebook_id_for_index(&self, notebook_id: Option<&str>) -> String {
        notebook_id
            .map(str::to_string)
            .unwrap_or_else(|| self.current_notebook_id_for_index())
    }

    pub(super) fn memo_base_for_notebook_id(&self, notebook_id: &str) -> PathBuf {
        self.read_notebook_configs()
            .ok()
            .and_then(|configs| configs.into_iter().find(|cfg| cfg.id == notebook_id))
            .map(|config| PathBuf::from(config.path))
            .unwrap_or_else(|| self.get_default_notebook_path())
    }

    fn ensure_memo_tables(&self, conn: &Connection) -> std::io::Result<()> {
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS memo_index_state (
                notebook_id TEXT PRIMARY KEY,
                version INTEGER NOT NULL,
                last_updated INTEGER NOT NULL,
                migrated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS notebook_data_migrations (
                notebook_id TEXT NOT NULL,
                migration_key TEXT NOT NULL,
                version INTEGER NOT NULL,
                completed_at INTEGER NOT NULL,
                PRIMARY KEY(notebook_id, migration_key)
            );
            CREATE TABLE IF NOT EXISTS schema_migrations (
                migration_key TEXT PRIMARY KEY,
                completed_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS memos (
                id TEXT PRIMARY KEY,
                notebook_id TEXT NOT NULL,
                filename TEXT NOT NULL,
                preview TEXT NOT NULL,
                thumbnail TEXT,
                thumbnail_checked INTEGER NOT NULL DEFAULT 0,
                agents_checked INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                favorited INTEGER NOT NULL,
                icon TEXT,
                properties TEXT NOT NULL DEFAULT '{}',
                FOREIGN KEY(notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
                UNIQUE(notebook_id, filename)
            );
            CREATE INDEX IF NOT EXISTS idx_memos_notebook_created
                ON memos(notebook_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_memos_notebook_updated
                ON memos(notebook_id, updated_at DESC);
            CREATE TABLE IF NOT EXISTS pending_external_memo_creates (
                memo_id TEXT PRIMARY KEY,
                notebook_id TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS memo_content_revisions (
                memo_id TEXT PRIMARY KEY,
                notebook_id TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                local_revision INTEGER NOT NULL,
                change_id TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY(notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_memo_content_revisions_notebook
                ON memo_content_revisions(notebook_id);
            CREATE TABLE IF NOT EXISTS memo_tags (
                memo_id TEXT NOT NULL,
                tag TEXT NOT NULL,
                PRIMARY KEY(memo_id, tag),
                FOREIGN KEY(memo_id) REFERENCES memos(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS notebook_tags (
                notebook_id TEXT NOT NULL,
                path TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(notebook_id, path),
                FOREIGN KEY(notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_notebook_tags_notebook
                ON notebook_tags(notebook_id);
            CREATE TRIGGER IF NOT EXISTS trg_memo_tags_register_notebook_tag
            AFTER INSERT ON memo_tags
            BEGIN
                INSERT OR IGNORE INTO notebook_tags
                    (notebook_id, path, created_at, updated_at)
                SELECT
                    m.notebook_id,
                    NEW.tag,
                    CAST(strftime('%s', 'now') AS INTEGER) * 1000,
                    CAST(strftime('%s', 'now') AS INTEGER) * 1000
                FROM memos m
                WHERE m.id = NEW.memo_id;
            END;
            CREATE TABLE IF NOT EXISTS memo_colors (
                memo_id TEXT NOT NULL,
                color TEXT NOT NULL,
                position INTEGER NOT NULL,
                PRIMARY KEY(memo_id, color),
                FOREIGN KEY(memo_id) REFERENCES memos(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS memo_todos (
                memo_id TEXT NOT NULL,
                content TEXT NOT NULL,
                status TEXT NOT NULL,
                priority TEXT NOT NULL DEFAULT '',
                time_range TEXT NOT NULL DEFAULT '',
                owner TEXT NOT NULL DEFAULT '',
                assignee TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0,
                position INTEGER NOT NULL,
                PRIMARY KEY(memo_id, content),
                FOREIGN KEY(memo_id) REFERENCES memos(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS memo_agents (
                memo_id TEXT NOT NULL,
                thread_id TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                agent_type TEXT NOT NULL DEFAULT '',
                position INTEGER NOT NULL,
                PRIMARY KEY(memo_id, thread_id),
                FOREIGN KEY(memo_id) REFERENCES memos(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_memo_agents_memo_id
                ON memo_agents(memo_id);
            "#,
        )
        .map_err(sqlite_to_io)?;
        conn.execute_batch(
            r#"
            INSERT OR IGNORE INTO notebook_tags
                (notebook_id, path, created_at, updated_at)
            SELECT DISTINCT
                m.notebook_id,
                mt.tag,
                CAST(strftime('%s', 'now') AS INTEGER) * 1000,
                CAST(strftime('%s', 'now') AS INTEGER) * 1000
            FROM memo_tags mt
            JOIN memos m ON m.id = mt.memo_id
            WHERE NOT EXISTS (
                SELECT 1
                FROM schema_migrations
                WHERE migration_key = 'notebook_tags_v1'
            );

            INSERT OR IGNORE INTO schema_migrations (migration_key, completed_at)
            VALUES (
                'notebook_tags_v1',
                CAST(strftime('%s', 'now') AS INTEGER) * 1000
            );
            "#,
        )
        .map_err(sqlite_to_io)?;
        Ok(())
    }

    pub(crate) fn open_memo_index_db(&self) -> std::io::Result<Connection> {
        let conn = self.open_index_db()?;
        self.ensure_memo_tables(&conn)?;
        Ok(conn)
    }

    /// Record an external-process create before its markdown file becomes visible.
    /// The Desktop watcher consumes this marker when it observes the filesystem event.
    pub fn mark_pending_external_memo_create(
        &self,
        memo_id: &str,
        notebook_id: &str,
    ) -> std::io::Result<()> {
        let conn = self.open_memo_index_db()?;
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "DELETE FROM pending_external_memo_creates WHERE created_at < ?1",
            params![now - EXTERNAL_CREATE_MARKER_TTL_MS],
        )
        .map_err(sqlite_to_io)?;
        conn.execute(
            r#"
            INSERT INTO pending_external_memo_creates (memo_id, notebook_id, created_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(memo_id) DO UPDATE SET
                notebook_id = excluded.notebook_id,
                created_at = excluded.created_at
            "#,
            params![memo_id, notebook_id, now],
        )
        .map_err(sqlite_to_io)?;
        Ok(())
    }

    /// Atomically claim an external create marker. A marker can produce at most one
    /// `Created` event even when the platform reports several filesystem events.
    pub fn consume_pending_external_memo_create(
        &self,
        memo_id: &str,
        notebook_id: &str,
    ) -> std::io::Result<bool> {
        let conn = self.open_memo_index_db()?;
        let cutoff = chrono::Utc::now().timestamp_millis() - EXTERNAL_CREATE_MARKER_TTL_MS;
        let changed = conn
            .execute(
                "DELETE FROM pending_external_memo_creates WHERE memo_id = ?1 AND notebook_id = ?2 AND created_at >= ?3",
                params![memo_id, notebook_id, cutoff],
            )
            .map_err(sqlite_to_io)?;
        Ok(changed > 0)
    }

    pub fn has_pending_external_memo_create(
        &self,
        memo_id: &str,
        notebook_id: &str,
    ) -> std::io::Result<bool> {
        let conn = self.open_memo_index_db()?;
        let cutoff = chrono::Utc::now().timestamp_millis() - EXTERNAL_CREATE_MARKER_TTL_MS;
        conn.query_row(
            "SELECT 1 FROM pending_external_memo_creates WHERE memo_id = ?1 AND notebook_id = ?2 AND created_at >= ?3",
            params![memo_id, notebook_id, cutoff],
            |_| Ok(()),
        )
        .optional()
        .map(|row| row.is_some())
        .map_err(sqlite_to_io)
    }

    pub fn clear_pending_external_memo_create(&self, memo_id: &str) -> std::io::Result<()> {
        let conn = self.open_memo_index_db()?;
        conn.execute(
            "DELETE FROM pending_external_memo_creates WHERE memo_id = ?1",
            params![memo_id],
        )
        .map_err(sqlite_to_io)?;
        Ok(())
    }

    /// Atomically records a stable content revision for a memo.
    ///
    /// Re-observing identical bytes returns the existing revision/change id.
    /// Returning to an older hash after another commit is a new transition and
    /// therefore advances the counter as well.
    pub fn commit_memo_content_revision(
        &self,
        memo_id: &str,
        notebook_id: &str,
        content_hash: &str,
        next_change_id: &str,
    ) -> std::io::Result<MemoContentCommit> {
        let mut conn = self.open_memo_index_db()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sqlite_to_io)?;
        let current = tx
            .query_row(
                "SELECT content_hash, local_revision, change_id, updated_at
                 FROM memo_content_revisions WHERE memo_id = ?1",
                params![memo_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(sqlite_to_io)?;

        if let Some((existing_hash, revision, change_id, updated_at)) = current.as_ref() {
            if existing_hash == content_hash {
                tx.commit().map_err(sqlite_to_io)?;
                return Ok(MemoContentCommit {
                    state: MemoContentRevision {
                        memo_id: memo_id.to_string(),
                        notebook_id: notebook_id.to_string(),
                        content_hash: existing_hash.clone(),
                        revision: *revision,
                        change_id: change_id.clone(),
                        updated_at: *updated_at,
                    },
                    changed: false,
                });
            }
        }

        let revision = current
            .as_ref()
            .map(|(_, revision, _, _)| revision.saturating_add(1))
            .unwrap_or(1);
        let updated_at = chrono::Utc::now().timestamp_millis();
        tx.execute(
            r#"
            INSERT INTO memo_content_revisions
                (memo_id, notebook_id, content_hash, local_revision, change_id, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(memo_id) DO UPDATE SET
                notebook_id = excluded.notebook_id,
                content_hash = excluded.content_hash,
                local_revision = excluded.local_revision,
                change_id = excluded.change_id,
                updated_at = excluded.updated_at
            "#,
            params![
                memo_id,
                notebook_id,
                content_hash,
                revision,
                next_change_id,
                updated_at,
            ],
        )
        .map_err(sqlite_to_io)?;
        tx.commit().map_err(sqlite_to_io)?;

        Ok(MemoContentCommit {
            state: MemoContentRevision {
                memo_id: memo_id.to_string(),
                notebook_id: notebook_id.to_string(),
                content_hash: content_hash.to_string(),
                revision,
                change_id: next_change_id.to_string(),
                updated_at,
            },
            changed: true,
        })
    }

    pub fn read_memo_content_revision(
        &self,
        memo_id: &str,
    ) -> std::io::Result<Option<MemoContentRevision>> {
        let conn = self.open_memo_index_db()?;
        conn.query_row(
            "SELECT notebook_id, content_hash, local_revision, change_id, updated_at
             FROM memo_content_revisions WHERE memo_id = ?1",
            params![memo_id],
            |row| {
                Ok(MemoContentRevision {
                    memo_id: memo_id.to_string(),
                    notebook_id: row.get(0)?,
                    content_hash: row.get(1)?,
                    revision: row.get(2)?,
                    change_id: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(sqlite_to_io)
    }

    pub(super) fn mark_index_state(
        &self,
        conn: &Connection,
        notebook_id: &str,
        version: u32,
        last_updated: i64,
    ) -> std::io::Result<()> {
        conn.execute(
            r#"
            INSERT INTO memo_index_state
                (notebook_id, version, last_updated, migrated_at)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(notebook_id) DO UPDATE SET
                version = MAX(memo_index_state.version, excluded.version),
                last_updated = MAX(memo_index_state.last_updated + 1, excluded.last_updated)
            "#,
            params![
                notebook_id,
                version as i64,
                last_updated,
                chrono::Utc::now().timestamp_millis(),
            ],
        )
        .map_err(sqlite_to_io)?;
        Ok(())
    }

    pub(crate) fn notebook_data_migration_version(
        &self,
        notebook_id: &str,
        migration_key: &str,
    ) -> std::io::Result<Option<u32>> {
        let conn = self.open_memo_index_db()?;
        self.ensure_memo_tables(&conn)?;
        conn.query_row(
            "SELECT version FROM notebook_data_migrations
             WHERE notebook_id = ?1 AND migration_key = ?2",
            params![notebook_id, migration_key],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map(|version| version.map(|value| value.max(0) as u32))
        .map_err(sqlite_to_io)
    }

    pub(crate) fn mark_notebook_data_migration(
        &self,
        notebook_id: &str,
        migration_key: &str,
        version: u32,
    ) -> std::io::Result<()> {
        let conn = self.open_memo_index_db()?;
        self.ensure_memo_tables(&conn)?;
        conn.execute(
            "INSERT INTO notebook_data_migrations
                (notebook_id, migration_key, version, completed_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(notebook_id, migration_key) DO UPDATE SET
                version = MAX(notebook_data_migrations.version, excluded.version),
                completed_at = excluded.completed_at",
            params![
                notebook_id,
                migration_key,
                version as i64,
                chrono::Utc::now().timestamp_millis(),
            ],
        )
        .map_err(sqlite_to_io)?;
        Ok(())
    }
}
