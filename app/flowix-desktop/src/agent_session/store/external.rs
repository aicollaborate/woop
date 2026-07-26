//! External runtime session mappings and normalized event log.

use super::{external_default_title, ThreadManager};
use crate::agent_session::error::ThreadError;
use crate::agent_session::types::{AgentExternalEvent, NewAgentExternalEvent};
use rusqlite::{params, Connection, OptionalExtension};
use std::sync::Arc;

const MAX_EXTERNAL_EVENTS_PER_THREAD: i64 = 10_000;

fn session_metadata_cwd(metadata: Option<&serde_json::Value>) -> Option<String> {
    let value = metadata?;
    value
        .get("cwd")
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            value
                .get("metadata")
                .and_then(|metadata| metadata.get("cwd"))
                .and_then(serde_json::Value::as_str)
        })
        .or_else(|| {
            value
                .get("message")
                .and_then(|message| message.get("cwd"))
                .and_then(serde_json::Value::as_str)
        })
        .map(str::trim)
        .filter(|cwd| !cwd.is_empty())
        .map(str::to_string)
}

impl ThreadManager {
    pub async fn get_external_session(
        self: &Arc<Self>,
        thread_id: &str,
        runtime: &str,
    ) -> Result<Option<String>, ThreadError> {
        let thread_id = thread_id.to_string();
        let runtime = runtime.to_string();
        self.run_blocking(move |tm| tm.get_external_session_inner(&thread_id, &runtime))
            .await
    }

    fn get_external_session_inner(
        &self,
        thread_id: &str,
        runtime: &str,
    ) -> Result<Option<String>, ThreadError> {
        let conn = self.lock_conn();
        let session = conn
            .query_row(
                "SELECT external_session_id
                 FROM thread_external_sessions
                 WHERE thread_id = ?1 AND runtime = ?2",
                params![thread_id, runtime],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        Ok(session)
    }

    pub async fn find_thread_by_external_session(
        self: &Arc<Self>,
        external_session_id: &str,
        runtime: &str,
    ) -> Result<Option<String>, ThreadError> {
        let external_session_id = external_session_id.to_string();
        let runtime = runtime.to_string();
        self.run_blocking(move |tm| {
            tm.find_thread_by_external_session_inner(&external_session_id, &runtime)
        })
        .await
    }

    fn find_thread_by_external_session_inner(
        &self,
        external_session_id: &str,
        runtime: &str,
    ) -> Result<Option<String>, ThreadError> {
        let conn = self.lock_conn();
        let thread_id = conn
            .query_row(
                "SELECT thread_id
                 FROM thread_external_sessions
                 WHERE external_session_id = ?1 AND runtime = ?2
                 ORDER BY updated_at DESC
                 LIMIT 1",
                params![external_session_id, runtime],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(thread_id)
    }

    pub async fn upsert_external_session(
        self: &Arc<Self>,
        thread_id: &str,
        runtime: &str,
        external_session_id: &str,
        session_metadata: Option<serde_json::Value>,
    ) -> Result<(), ThreadError> {
        let thread_id = thread_id.to_string();
        let runtime = runtime.to_string();
        let external_session_id = external_session_id.to_string();
        self.run_blocking(move |tm| {
            tm.upsert_external_session_inner(
                &thread_id,
                &runtime,
                &external_session_id,
                session_metadata,
            )
        })
        .await
    }

    fn upsert_external_session_inner(
        &self,
        thread_id: &str,
        runtime: &str,
        external_session_id: &str,
        session_metadata: Option<serde_json::Value>,
    ) -> Result<(), ThreadError> {
        let now = chrono::Utc::now().timestamp_millis();
        let session_cwd = session_metadata_cwd(session_metadata.as_ref());
        let session_metadata_json = session_metadata.map(|v| v.to_string());
        let mut conn = self.lock_conn();
        let tx = conn.transaction()?;
        // A resumed process may report the canonical session id as its current
        // thread id. Reuse the existing product thread instead of attempting a
        // conflicting self-mapping for the same external session.
        let product_thread_id = tx
            .query_row(
                "SELECT thread_id
                 FROM thread_external_sessions
                 WHERE runtime = ?1 AND external_session_id = ?2
                 ORDER BY updated_at DESC
                 LIMIT 1",
                params![runtime, external_session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_else(|| thread_id.to_string());
        let default_title = external_default_title(runtime);
        tx.execute(
            "INSERT OR IGNORE INTO threads (thread_id, agent_id, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![product_thread_id, runtime, default_title, now],
        )?;

        let title = tx
            .query_row(
                "SELECT title FROM threads WHERE thread_id = ?1",
                [product_thread_id.as_str()],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_else(|| default_title.to_string());

        tx.execute(
            "INSERT INTO thread_external_sessions (
                thread_id, runtime, external_session_id, session_metadata_json, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(thread_id, runtime) DO UPDATE SET
                external_session_id = excluded.external_session_id,
                session_metadata_json = excluded.session_metadata_json,
                updated_at = excluded.updated_at",
            params![
                product_thread_id,
                runtime,
                external_session_id,
                session_metadata_json,
                now
            ],
        )?;
        tx.execute(
            "UPDATE agent_conversation_instances
             SET title = ?1,
                 frozen_cwd = COALESCE(?2, frozen_cwd),
                 updated_at = max(updated_at, ?3)
             WHERE thread_id IN (?4, ?5, ?6)",
            params![
                title,
                session_cwd,
                now,
                product_thread_id,
                thread_id,
                external_session_id
            ],
        )?;
        self.touch_thread(&tx, &product_thread_id, now)?;
        tx.commit()?;
        Ok(())
    }

    pub async fn insert_agent_external_event(
        self: &Arc<Self>,
        event: NewAgentExternalEvent,
    ) -> Result<i64, ThreadError> {
        self.run_blocking(move |tm| tm.insert_agent_external_event_inner(event))
            .await
    }

    fn insert_agent_external_event_inner(
        &self,
        event: NewAgentExternalEvent,
    ) -> Result<i64, ThreadError> {
        let now = event
            .created_at
            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
        let conn = self.lock_conn();
        let thread_id = event.thread_id.clone();
        conn.execute(
            "INSERT OR IGNORE INTO threads (thread_id, agent_id, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![
                thread_id.as_str(),
                event.runtime.as_str(),
                external_default_title(&event.runtime),
                now,
            ],
        )?;
        conn.execute(
            "INSERT INTO agent_external_events (
                runtime, thread_id, normalized_json, raw_json, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                event.runtime.as_str(),
                event.thread_id.as_str(),
                event.normalized_json.as_str(),
                event.raw_json.as_deref(),
                now,
            ],
        )?;
        let id = conn.last_insert_rowid();
        self.prune_agent_external_events_for_thread(&conn, &event.thread_id)?;
        Ok(id)
    }

    fn prune_agent_external_events_for_thread(
        &self,
        conn: &Connection,
        thread_id: &str,
    ) -> Result<(), ThreadError> {
        conn.execute(
            "DELETE FROM agent_external_events
             WHERE thread_id = ?1
               AND id NOT IN (
                   SELECT id
                   FROM agent_external_events
                   WHERE thread_id = ?1
                   ORDER BY id DESC
                   LIMIT ?2
               )",
            params![thread_id, MAX_EXTERNAL_EVENTS_PER_THREAD],
        )?;
        Ok(())
    }

    pub async fn list_agent_external_events_by_thread(
        self: &Arc<Self>,
        thread_id: &str,
        after_id: Option<i64>,
        limit: i64,
    ) -> Result<Vec<AgentExternalEvent>, ThreadError> {
        let thread_id = thread_id.to_string();
        self.run_blocking(move |tm| {
            tm.list_agent_external_events_by_thread_inner(&thread_id, after_id, limit)
        })
        .await
    }

    fn list_agent_external_events_by_thread_inner(
        &self,
        thread_id: &str,
        after_id: Option<i64>,
        limit: i64,
    ) -> Result<Vec<AgentExternalEvent>, ThreadError> {
        let limit = limit.clamp(1, 1000);
        let after_id = after_id.unwrap_or(0);
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT
                id, runtime, thread_id, normalized_json, raw_json, created_at
             FROM agent_external_events
             WHERE thread_id = ?1 AND id > ?2
             ORDER BY id ASC
             LIMIT ?3",
        )?;
        let rows = stmt.query_map(
            params![thread_id, after_id, limit],
            Self::row_to_external_event,
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    fn row_to_external_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentExternalEvent> {
        Ok(AgentExternalEvent {
            id: row.get(0)?,
            runtime: row.get(1)?,
            thread_id: row.get(2)?,
            normalized_json: row.get(3)?,
            raw_json: row.get(4)?,
            created_at: row.get(5)?,
        })
    }
}
