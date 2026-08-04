//! External runtime session mappings and normalized event log.

use super::{external_default_title, ThreadManager};
use crate::agent_session::error::ThreadError;
use crate::agent_session::types::{
    AgentExternalEvent, ChatMessage, NewAgentExternalEvent, ThreadInfo, ThreadMessagesPage,
};
use crate::agent_types::AgentId;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;

const MAX_EXTERNAL_EVENTS_PER_THREAD: i64 = 10_000;
const EXTERNAL_HISTORY_TRUNCATED_JSON: &str = r#"{"kind":"history_truncated","version":1}"#;

fn derive_external_event_key(runtime: &str, payload: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(payload).ok()?;
    let run_id = value.get("run_id").and_then(|v| v.as_str()).map(str::trim);
    let kind = value.get("kind").and_then(|v| v.as_str()).map(str::trim);
    let sequence = value
        .get("source_sequence")
        .and_then(serde_json::Value::as_u64);
    if let (Some(run_id), Some(kind), Some(sequence)) = (run_id, kind, sequence) {
        let subsequence = value
            .get("source_subsequence")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        return Some(format!(
            "{runtime}:{run_id}:{kind}:{sequence}:{subsequence}"
        ));
    }

    // Older adapters may not provide source sequence metadata. Hashing the
    // canonical payload still makes exact retries idempotent without merging
    // distinct events that merely share a run id or kind.
    let mut hasher = Sha256::new();
    hasher.update(payload.as_bytes());
    Some(format!("{runtime}:payload:{:x}", hasher.finalize()))
}

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
    /// List only product-owned OpenCode threads. Session ids can temporarily
    /// appear in `threads` when an event arrives through a canonical UI id;
    /// those aliases must not become duplicate cards.
    pub async fn list_opencode_event_threads(
        self: &Arc<Self>,
    ) -> Result<Vec<ThreadInfo>, ThreadError> {
        self.run_blocking(move |tm| {
            let conn = tm.lock_conn();
            let mut stmt = conn.prepare(
                "SELECT t.thread_id, t.agent_id, t.title, t.created_at, t.updated_at
                 FROM threads t
                 WHERE t.agent_id = 'opencode'
                   AND NOT EXISTS (
                       SELECT 1 FROM thread_external_sessions s
                       WHERE s.runtime = 'opencode'
                         AND s.external_session_id = t.thread_id
                   )
                 ORDER BY t.updated_at DESC",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(ThreadInfo {
                    thread_id: row.get(0)?,
                    agent_id: AgentId(row.get(1)?),
                    title: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await
    }

    /// List product-owned Codex threads only. A resolved Codex session id may
    /// also exist in `threads` because older turns persisted chunks using the
    /// frontend's canonical id; those alias rows must not render as cards.
    pub async fn list_codex_event_threads(
        self: &Arc<Self>,
    ) -> Result<Vec<ThreadInfo>, ThreadError> {
        self.run_blocking(move |tm| {
            let conn = tm.lock_conn();
            let mut stmt = conn.prepare(
                "SELECT t.thread_id, t.agent_id, t.title, t.created_at, t.updated_at
                 FROM threads t
                 WHERE t.agent_id = 'codex'
                   AND NOT EXISTS (
                       SELECT 1 FROM thread_external_sessions s
                       WHERE s.runtime = 'codex'
                         AND s.external_session_id = t.thread_id
                   )
                 ORDER BY t.updated_at DESC",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(ThreadInfo {
                    thread_id: row.get(0)?,
                    agent_id: AgentId(row.get(1)?),
                    title: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .await
    }

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
             SET frozen_cwd = COALESCE(?1, frozen_cwd),
                 updated_at = max(updated_at, ?2)
             WHERE thread_id IN (?3, ?4, ?5)",
            params![
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
        let event_key = derive_external_event_key(&event.runtime, &event.normalized_json);
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
            "INSERT OR IGNORE INTO agent_external_events (
                runtime, thread_id, event_key, normalized_json, raw_json, created_at
             ) VALUES (?1, ?2, NULLIF(?3, ''), ?4, ?5, ?6)",
            params![
                event.runtime.as_str(),
                event.thread_id.as_str(),
                event_key.as_deref(),
                event.normalized_json.as_str(),
                event.raw_json.as_deref(),
                now,
            ],
        )?;
        let id = conn.query_row(
            "SELECT id FROM agent_external_events
             WHERE runtime = ?1 AND thread_id = ?2
               AND ((?3 IS NOT NULL AND event_key = ?3) OR (?3 IS NULL AND id = last_insert_rowid()))
             ORDER BY id DESC LIMIT 1",
            params![
                event.runtime.as_str(),
                event.thread_id.as_str(),
                event_key.as_deref(),
            ],
            |row| row.get(0),
        )?;
        self.prune_agent_external_events_for_thread(&conn, &event.thread_id)?;
        Ok(id)
    }

    fn prune_agent_external_events_for_thread(
        &self,
        conn: &Connection,
        thread_id: &str,
    ) -> Result<(), ThreadError> {
        let deleted = conn.execute(
            "DELETE FROM agent_external_events
             WHERE thread_id = ?1
               AND normalized_json <> ?3
               AND id NOT IN (
                   SELECT id
                   FROM agent_external_events
                   WHERE thread_id = ?1 AND normalized_json <> ?3
                   ORDER BY id DESC
                   LIMIT ?2
               )",
            params![
                thread_id,
                MAX_EXTERNAL_EVENTS_PER_THREAD,
                EXTERNAL_HISTORY_TRUNCATED_JSON
            ],
        )?;
        if deleted > 0 {
            conn.execute(
                "INSERT INTO agent_external_events (
                    runtime, thread_id, normalized_json, raw_json, created_at
                 )
                 SELECT agent_id, ?1, ?2, NULL, ?3
                 FROM threads
                 WHERE thread_id = ?1
                   AND NOT EXISTS (
                       SELECT 1
                       FROM agent_external_events
                       WHERE thread_id = ?1 AND normalized_json = ?2
                   )",
                params![
                    thread_id,
                    EXTERNAL_HISTORY_TRUNCATED_JSON,
                    chrono::Utc::now().timestamp_millis()
                ],
            )?;
        }
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
                id, runtime, thread_id, event_key, normalized_json, raw_json, created_at
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
            event_key: row.get(3)?,
            normalized_json: row.get(4)?,
            raw_json: row.get(5)?,
            created_at: row.get(6)?,
        })
    }

    /// Read OpenCode history in complete user-turn pages and materialize the
    /// compact snapshot events as display messages. `before_event_id` is the
    /// first user event id returned by the previous page.
    pub async fn get_opencode_event_messages_page(
        self: &Arc<Self>,
        thread_id: &str,
        before_event_id: Option<i64>,
        turn_limit: i64,
    ) -> Result<Option<ThreadMessagesPage>, ThreadError> {
        let thread_id = thread_id.to_string();
        self.run_blocking(move |tm| {
            if !tm.external_event_history_exists_inner("opencode", &thread_id)? {
                return Ok(None);
            }
            tm.get_external_event_messages_page_inner(
                "opencode",
                &thread_id,
                before_event_id,
                turn_limit,
            )
            .map(Some)
        })
        .await
    }

    pub async fn get_codex_event_messages_page(
        self: &Arc<Self>,
        thread_id: &str,
        before_event_id: Option<i64>,
        turn_limit: i64,
    ) -> Result<Option<ThreadMessagesPage>, ThreadError> {
        let thread_id = thread_id.to_string();
        self.run_blocking(move |tm| {
            if !tm.external_event_history_exists_inner("codex", &thread_id)? {
                return Ok(None);
            }
            tm.get_external_event_messages_page_inner(
                "codex",
                &thread_id,
                before_event_id,
                turn_limit,
            )
            .map(Some)
        })
        .await
    }

    pub async fn get_claude_event_messages_page(
        self: &Arc<Self>,
        thread_id: &str,
        before_event_id: Option<i64>,
        turn_limit: i64,
    ) -> Result<Option<ThreadMessagesPage>, ThreadError> {
        let thread_id = thread_id.to_string();
        self.run_blocking(move |tm| {
            if !tm.external_event_history_exists_inner("claude", &thread_id)? {
                return Ok(None);
            }
            tm.get_external_event_messages_page_inner(
                "claude",
                &thread_id,
                before_event_id,
                turn_limit,
            )
            .map(Some)
        })
        .await
    }

    pub async fn get_external_event_messages_page(
        self: &Arc<Self>,
        runtime: &str,
        thread_id: &str,
        before_event_id: Option<i64>,
        turn_limit: i64,
    ) -> Result<Option<ThreadMessagesPage>, ThreadError> {
        let runtime = runtime.to_string();
        let thread_id = thread_id.to_string();
        self.run_blocking(move |tm| {
            if !tm.external_event_history_exists_inner(&runtime, &thread_id)? {
                return Ok(None);
            }
            tm.get_external_event_messages_page_inner(
                &runtime,
                &thread_id,
                before_event_id,
                turn_limit,
            )
            .map(Some)
        })
        .await
    }

    fn external_event_history_exists_inner(
        &self,
        runtime: &str,
        thread_id: &str,
    ) -> Result<bool, ThreadError> {
        let conn = self.lock_conn();
        let product_thread_id = conn
            .query_row(
                "SELECT thread_id FROM thread_external_sessions
                 WHERE runtime = ?2 AND external_session_id = ?1
                 ORDER BY updated_at DESC LIMIT 1",
                params![thread_id, runtime],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_else(|| thread_id.to_string());
        let external_session_id = conn
            .query_row(
                "SELECT external_session_id FROM thread_external_sessions
                 WHERE thread_id = ?1 AND runtime = ?2
                 ORDER BY updated_at DESC LIMIT 1",
                params![product_thread_id.as_str(), runtime],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_else(|| product_thread_id.clone());
        Ok(conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM agent_external_events
                WHERE thread_id IN (?1, ?2) AND runtime = ?3
             )",
            params![product_thread_id, external_session_id, runtime],
            |row| row.get(0),
        )?)
    }

    fn get_external_event_messages_page_inner(
        &self,
        runtime: &str,
        thread_id: &str,
        before_event_id: Option<i64>,
        turn_limit: i64,
    ) -> Result<ThreadMessagesPage, ThreadError> {
        let turn_limit = turn_limit.clamp(1, 50);
        let conn = self.lock_conn();
        let product_thread_id = conn
            .query_row(
                "SELECT thread_id FROM thread_external_sessions
                 WHERE runtime = ?2 AND external_session_id = ?1
                 ORDER BY updated_at DESC LIMIT 1",
                params![thread_id, runtime],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_else(|| thread_id.to_string());
        let external_session_id = conn
            .query_row(
                "SELECT external_session_id FROM thread_external_sessions
                 WHERE runtime = ?2 AND thread_id = ?1
                 ORDER BY updated_at DESC LIMIT 1",
                params![product_thread_id.as_str(), runtime],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_else(|| product_thread_id.clone());
        let upper_bound = before_event_id.unwrap_or(i64::MAX);

        let mut turn_stmt = conn.prepare(
            "SELECT e.id FROM agent_external_events e
             WHERE e.thread_id IN (?1, ?2) AND e.runtime = ?3 AND e.id < ?4
               AND (
                   json_extract(e.normalized_json, '$.kind') = 'user_message'
                   OR (
                       json_extract(e.normalized_json, '$.kind') = 'stream_start'
                       AND NOT EXISTS (
                           SELECT 1 FROM agent_external_events u
                           WHERE u.thread_id IN (?1, ?2) AND u.runtime = ?3
                             AND json_extract(u.normalized_json, '$.kind') = 'user_message'
                             AND json_extract(u.normalized_json, '$.run_id')
                                 = json_extract(e.normalized_json, '$.run_id')
                       )
                   )
               )
             ORDER BY e.id DESC LIMIT ?5",
        )?;
        let turn_ids = turn_stmt
            .query_map(
                params![
                    product_thread_id.as_str(),
                    external_session_id.as_str(),
                    runtime,
                    upper_bound,
                    turn_limit
                ],
                |row| row.get::<_, i64>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let Some(cutoff_id) = turn_ids.last().copied() else {
            return Ok(ThreadMessagesPage {
                messages: Vec::new(),
                oldest_sequence: None,
                has_more: false,
            });
        };

        let mut event_stmt = conn.prepare(
            "SELECT id, runtime, thread_id, event_key, normalized_json, raw_json, created_at
             FROM agent_external_events
             WHERE thread_id IN (?1, ?2) AND runtime = ?3
               AND id >= ?4 AND id < ?5
             ORDER BY id ASC",
        )?;
        let events = event_stmt
            .query_map(
                params![
                    product_thread_id.as_str(),
                    external_session_id.as_str(),
                    runtime,
                    cutoff_id,
                    upper_bound
                ],
                Self::row_to_external_event,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let has_more = conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM agent_external_events e
                WHERE e.thread_id IN (?1, ?2) AND e.runtime = ?3 AND e.id < ?4
                  AND (
                      json_extract(e.normalized_json, '$.kind') = 'user_message'
                      OR (
                          json_extract(e.normalized_json, '$.kind') = 'stream_start'
                          AND NOT EXISTS (
                              SELECT 1 FROM agent_external_events u
                              WHERE u.thread_id IN (?1, ?2) AND u.runtime = ?3
                                AND json_extract(u.normalized_json, '$.kind') = 'user_message'
                                AND json_extract(u.normalized_json, '$.run_id')
                                    = json_extract(e.normalized_json, '$.run_id')
                          )
                      )
                  )
             )",
            params![
                product_thread_id.as_str(),
                external_session_id.as_str(),
                runtime,
                cutoff_id
            ],
            |row| row.get::<_, bool>(0),
        )?;

        Ok(ThreadMessagesPage {
            messages: materialize_external_messages(events),
            oldest_sequence: Some(cutoff_id),
            has_more,
        })
    }
}

fn materialize_external_messages(events: Vec<AgentExternalEvent>) -> Vec<ChatMessage> {
    let mut messages = Vec::new();
    let mut tool_indexes = HashMap::<String, usize>::new();
    let mut message_indexes = HashMap::<String, usize>::new();
    for event in events {
        let Ok(payload) = serde_json::from_str::<serde_json::Value>(&event.normalized_json) else {
            continue;
        };
        let kind = payload.get("kind").and_then(serde_json::Value::as_str);
        let timestamp = chrono::DateTime::from_timestamp_millis(event.created_at)
            .unwrap_or_default()
            .to_rfc3339();
        let stable_message_id = payload
            .get("message_id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let message_id = stable_message_id
            .clone()
            .unwrap_or_else(|| format!("external-event-{}", event.id));
        match kind {
            Some("user_message") => {
                let raw_id = payload
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(&message_id)
                    .to_string();
                let id = external_run_scoped_id(&event.runtime, &payload, "user", &raw_id);
                messages.push(external_history_message(
                    id,
                    "user",
                    payload
                        .get("text")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    timestamp,
                ));
            }
            Some("text") | Some("reasoning") => {
                let role = if kind == Some("reasoning") {
                    "reasoning"
                } else {
                    "assistant"
                };
                let message_id =
                    external_run_scoped_id(&event.runtime, &payload, role, &message_id);
                let content = payload
                    .get("text")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let content_mode = payload
                    .get("content_mode")
                    .and_then(serde_json::Value::as_str);
                let stable_key = stable_message_id.as_ref().map(|_| message_id.clone());
                let existing_index = stable_key
                    .as_ref()
                    .and_then(|key| message_indexes.get(key).copied());
                if let Some(index) = existing_index {
                    if content_mode == Some("snapshot") {
                        messages[index].content = content;
                    } else {
                        messages[index].content.push_str(&content);
                    }
                    messages[index].is_completed = Some(
                        payload
                            .get("message_phase")
                            .and_then(serde_json::Value::as_str)
                            == Some("completed"),
                    );
                    continue;
                }
                let mut message = external_history_message(message_id, role, content, timestamp);
                message.is_completed = Some(
                    payload
                        .get("message_phase")
                        .and_then(serde_json::Value::as_str)
                        == Some("completed"),
                );
                if let Some(key) = stable_key {
                    message_indexes.insert(key, messages.len());
                }
                messages.push(message);
            }
            Some("tool_call") => {
                let raw_tool_call_id = payload
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(&message_id)
                    .to_string();
                let tool_call_id = external_run_scoped_id(
                    &event.runtime,
                    &payload,
                    "tool-call",
                    &raw_tool_call_id,
                );
                let tool_message_id = message_id.clone();
                let message_id =
                    external_run_scoped_id(&event.runtime, &payload, "tool", &tool_message_id);
                let mut message =
                    external_history_message(message_id, "tool", String::new(), timestamp);
                message.tool_call_id = Some(tool_call_id.clone());
                message.tool_name = payload
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string);
                message.tool_input = payload.get("input").cloned();
                message.is_loading = Some(true);
                message.is_completed = Some(false);
                tool_indexes.insert(tool_call_id, messages.len());
                messages.push(message);
            }
            Some("tool_result") => {
                let Some(raw_tool_call_id) = payload
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
                else {
                    continue;
                };
                let tool_call_id = external_run_scoped_id(
                    &event.runtime,
                    &payload,
                    "tool-call",
                    &raw_tool_call_id,
                );
                let result = payload.get("result").cloned().unwrap_or_default();
                let content = result
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| result.to_string());
                if let Some(index) = tool_indexes.get(&tool_call_id).copied() {
                    let message = &mut messages[index];
                    message.content = content.clone();
                    message.tool_data = Some(content);
                    message.is_loading = Some(false);
                    message.is_completed = Some(true);
                }
            }
            Some("error") => messages.push(external_history_message(
                message_id,
                "assistant",
                payload
                    .get("message")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                timestamp,
            )),
            _ => {}
        }
    }
    messages
}

fn external_run_scoped_id(
    runtime: &str,
    payload: &serde_json::Value,
    role: &str,
    item_id: &str,
) -> String {
    let run_id = payload
        .get("run_id")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty());
    if let Some(run_id) = run_id {
        return crate::agent_external::canonical_message_id(runtime, run_id, role, item_id);
    }
    item_id.to_string()
}

fn external_history_message(
    id: String,
    role: &str,
    content: String,
    timestamp: String,
) -> ChatMessage {
    ChatMessage {
        id,
        role: role.to_string(),
        content,
        llm_content: None,
        system_reminder_directory: None,
        timestamp,
        is_loading: None,
        tool_call_id: None,
        tool_name: None,
        tool_data: None,
        tool_input: None,
        tool_calls: None,
        reasoning: None,
        is_completed: Some(true),
        is_collapsed: None,
    }
}
