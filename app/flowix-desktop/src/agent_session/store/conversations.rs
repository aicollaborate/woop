//! Agent conversation instances, frozen working directories, and lifecycle cleanup.

use super::ThreadManager;
use crate::agent_session::error::ThreadError;
use crate::agent_session::types::{
    AgentConversationInstance, AgentConversationRole, AgentConversationSource,
    UpsertAgentConversationInstance,
};
use rusqlite::{params, OptionalExtension};
use std::path::PathBuf;
use std::sync::Arc;

fn sanitize_frontend_runtime_config(raw: Option<String>) -> Option<String> {
    let raw = raw?;
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Some(raw);
    };
    let removed = value
        .as_object_mut()
        .and_then(|object| object.remove("frozenCwd"))
        .is_some();
    if !removed {
        return Some(raw);
    }
    Some(serde_json::to_string(&value).unwrap_or(raw))
}

impl ThreadManager {
    pub async fn list_agent_conversation_instances(
        self: &Arc<Self>,
    ) -> Result<Vec<AgentConversationInstance>, ThreadError> {
        self.run_blocking(move |tm| tm.list_agent_conversation_instances_inner())
            .await
    }

    fn list_agent_conversation_instances_inner(
        &self,
    ) -> Result<Vec<AgentConversationInstance>, ThreadError> {
        let conn = self.lock_conn();
        let mut stmt = conn.prepare(
            "SELECT
                i.instance_id, i.agent_type, t.title, i.thread_id, i.runtime_config,
                i.frozen_cwd, i.source_kind, i.source_document_path, i.source_memo_id,
                i.role_memo_id, i.role_name, i.created_at, i.updated_at
             FROM agent_conversation_instances i
             LEFT JOIN threads t ON t.thread_id = i.thread_id
             ORDER BY i.updated_at DESC",
        )?;
        let rows = stmt.query_map([], Self::row_to_agent_conversation_instance)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub async fn get_agent_conversation_instance(
        self: &Arc<Self>,
        instance_id: &str,
    ) -> Result<Option<AgentConversationInstance>, ThreadError> {
        let instance_id = instance_id.to_string();
        self.run_blocking(move |tm| tm.get_agent_conversation_instance_inner(&instance_id))
            .await
    }

    fn get_agent_conversation_instance_inner(
        &self,
        instance_id: &str,
    ) -> Result<Option<AgentConversationInstance>, ThreadError> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT
                i.instance_id, i.agent_type, t.title, i.thread_id, i.runtime_config,
                i.frozen_cwd, i.source_kind, i.source_document_path, i.source_memo_id,
                i.role_memo_id, i.role_name, i.created_at, i.updated_at
             FROM agent_conversation_instances i
             LEFT JOIN threads t ON t.thread_id = i.thread_id
             WHERE i.instance_id = ?1",
            [instance_id],
            Self::row_to_agent_conversation_instance,
        )
        .optional()
        .map_err(ThreadError::from)
    }

    pub async fn find_agent_conversation_by_thread_id(
        self: &Arc<Self>,
        thread_id: &str,
    ) -> Result<Option<AgentConversationInstance>, ThreadError> {
        let thread_id = thread_id.to_string();
        self.run_blocking(move |tm| tm.find_agent_conversation_by_thread_id_inner(&thread_id))
            .await
    }

    fn find_agent_conversation_by_thread_id_inner(
        &self,
        thread_id: &str,
    ) -> Result<Option<AgentConversationInstance>, ThreadError> {
        let conn = self.lock_conn();
        conn.query_row(
            "SELECT
                i.instance_id, i.agent_type, t.title, i.thread_id, i.runtime_config,
                i.frozen_cwd, i.source_kind, i.source_document_path, i.source_memo_id,
                i.role_memo_id, i.role_name, i.created_at, i.updated_at
             FROM agent_conversation_instances i
             LEFT JOIN threads t ON t.thread_id = i.thread_id
             WHERE i.thread_id = ?1
             ORDER BY i.updated_at DESC
             LIMIT 1",
            [thread_id],
            Self::row_to_agent_conversation_instance,
        )
        .optional()
        .map_err(ThreadError::from)
    }

    pub async fn upsert_agent_conversation_instance(
        self: &Arc<Self>,
        input: UpsertAgentConversationInstance,
    ) -> Result<AgentConversationInstance, ThreadError> {
        self.run_blocking(move |tm| tm.upsert_agent_conversation_instance_inner(input))
            .await
    }

    fn upsert_agent_conversation_instance_inner(
        &self,
        input: UpsertAgentConversationInstance,
    ) -> Result<AgentConversationInstance, ThreadError> {
        let instance_id = input.instance_id.clone();
        let runtime_config = sanitize_frontend_runtime_config(input.runtime_config);
        let now = chrono::Utc::now().timestamp_millis();
        let created_at = input.created_at.unwrap_or(now);
        let updated_at = input.updated_at.unwrap_or(now);
        let source_kind = if input.source.kind.trim().is_empty() {
            "thread-card".to_string()
        } else {
            input.source.kind
        };
        let role_memo_id = input.role.as_ref().and_then(|role| role.memo_id.clone());
        let role_name = input.role.as_ref().and_then(|role| role.name.clone());
        let mut conn = self.lock_conn();
        let tx = conn.transaction()?;
        if let Some(thread_id) = input.thread_id.as_deref() {
            let existing_owner = tx
                .query_row(
                    "SELECT instance_id FROM agent_conversation_instances
                     WHERE thread_id = ?1 AND instance_id <> ?2
                     LIMIT 1",
                    params![thread_id, input.instance_id.as_str()],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            if existing_owner.is_some() {
                return Err(ThreadError::ConversationThreadConflict {
                    thread_id: thread_id.to_string(),
                    instance_id: input.instance_id,
                });
            }
            // External-agent cards can bind to a temporary product thread id
            // before the first event arrives. Create the product row here so
            // the 1:1 foreign key remains valid without making the frontend
            // perform a second race-prone write.
            tx.execute(
                "INSERT OR IGNORE INTO threads (
                    thread_id, agent_id, title, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    thread_id,
                    input.agent_type.as_str(),
                    input.initial_title.as_str(),
                    created_at,
                    updated_at,
                ],
            )?;
        }
        tx.execute(
            "INSERT INTO agent_conversation_instances (
                instance_id, agent_type, thread_id,
                runtime_config, source_kind, source_document_path, source_memo_id,
                role_memo_id, role_name, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(instance_id) DO UPDATE SET
                agent_type = excluded.agent_type,
                thread_id = excluded.thread_id,
                runtime_config = excluded.runtime_config,
                source_kind = excluded.source_kind,
                source_document_path = excluded.source_document_path,
                source_memo_id = excluded.source_memo_id,
                role_memo_id = excluded.role_memo_id,
                 role_name = excluded.role_name,
                 updated_at = excluded.updated_at
              WHERE excluded.updated_at >= agent_conversation_instances.updated_at",
            params![
                input.instance_id,
                input.agent_type,
                input.thread_id,
                runtime_config,
                source_kind,
                input.source.document_path,
                input.source.memo_id,
                role_memo_id,
                role_name,
                created_at,
                updated_at,
            ],
        )?;
        let instance = tx
            .query_row(
                "SELECT
                    i.instance_id, i.agent_type, t.title, i.thread_id, i.runtime_config,
                    i.frozen_cwd, i.source_kind, i.source_document_path, i.source_memo_id,
                    i.role_memo_id, i.role_name, i.created_at, i.updated_at
                 FROM agent_conversation_instances i
                 LEFT JOIN threads t ON t.thread_id = i.thread_id
                 WHERE i.instance_id = ?1",
                [instance_id.as_str()],
                Self::row_to_agent_conversation_instance,
            )
            .optional()?;
        tx.commit()?;
        instance.ok_or_else(|| ThreadError::NotFound(instance_id))
    }

    /// Read the backend-owned working directory for a conversation.
    ///
    /// The lookup accepts either the product thread id or its external session
    /// id, so frontend session reconciliation cannot change cwd ownership.
    pub async fn read_frozen_cwd(
        self: &Arc<Self>,
        thread_id: &str,
    ) -> Result<Option<PathBuf>, ThreadError> {
        let thread_id = thread_id.to_string();
        self.run_blocking(move |tm| tm.read_frozen_cwd_inner(&thread_id))
            .await
    }

    fn read_frozen_cwd_inner(&self, thread_id: &str) -> Result<Option<PathBuf>, ThreadError> {
        let conn = self.lock_conn();
        let frozen_cwd = conn
            .query_row(
                "SELECT i.frozen_cwd
                 FROM agent_conversation_instances i
                 WHERE i.thread_id = ?1
                    OR i.thread_id IN (
                        SELECT s.thread_id FROM thread_external_sessions s
                        WHERE s.external_session_id = ?1
                    )
                    OR i.thread_id IN (
                        SELECT s.external_session_id FROM thread_external_sessions s
                        WHERE s.thread_id = ?1
                    )
                 ORDER BY CASE WHEN i.thread_id = ?1 THEN 0 ELSE 1 END,
                          i.updated_at DESC
                 LIMIT 1",
                [thread_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        Ok(frozen_cwd.map(PathBuf::from))
    }

    /// Persist `cwd` as the frozen working directory for a conversation.
    ///
    /// Called once on the first turn after the runtime-specific resolver picks
    /// a concrete directory; subsequent turns read it back via `read_frozen_cwd`
    /// and skip resolution, so the cwd never drifts mid-conversation.
    pub async fn upsert_frozen_cwd(
        self: &Arc<Self>,
        thread_id: &str,
        cwd: &std::path::Path,
    ) -> Result<(), ThreadError> {
        let thread_id = thread_id.to_string();
        let cwd = cwd.to_path_buf();
        self.run_blocking(move |tm| tm.upsert_frozen_cwd_inner(&thread_id, &cwd))
            .await
    }

    fn upsert_frozen_cwd_inner(
        &self,
        thread_id: &str,
        cwd: &std::path::Path,
    ) -> Result<(), ThreadError> {
        let now = chrono::Utc::now().timestamp_millis();
        let conn = self.lock_conn();
        let updated = conn.execute(
            "UPDATE agent_conversation_instances
             SET frozen_cwd = ?1, updated_at = max(updated_at, ?2)
             WHERE instance_id = (
                 SELECT i.instance_id
                 FROM agent_conversation_instances i
                 WHERE i.thread_id = ?3
                    OR i.thread_id IN (
                        SELECT s.thread_id FROM thread_external_sessions s
                        WHERE s.external_session_id = ?3
                    )
                    OR i.thread_id IN (
                        SELECT s.external_session_id FROM thread_external_sessions s
                        WHERE s.thread_id = ?3
                    )
                 ORDER BY CASE WHEN i.thread_id = ?3 THEN 0 ELSE 1 END,
                          i.updated_at DESC
                 LIMIT 1
             )",
            params![cwd.to_string_lossy(), now, thread_id],
        )?;
        if updated == 0 {
            return Err(ThreadError::NotFound(thread_id.to_string()));
        }
        Ok(())
    }

    pub async fn delete_agent_conversation_instance(
        self: &Arc<Self>,
        instance_id: &str,
    ) -> Result<bool, ThreadError> {
        let instance_id = instance_id.to_string();
        self.run_blocking(move |tm| tm.delete_agent_conversation_instance_inner(&instance_id))
            .await
    }

    fn delete_agent_conversation_instance_inner(
        &self,
        instance_id: &str,
    ) -> Result<bool, ThreadError> {
        let conn = self.lock_conn();
        let deleted = conn.execute(
            "DELETE FROM agent_conversation_instances WHERE instance_id = ?1",
            [instance_id],
        )?;
        Ok(deleted > 0)
    }

    pub async fn delete_agent_conversation_instances_for_thread(
        self: &Arc<Self>,
        thread_id: &str,
    ) -> Result<u64, ThreadError> {
        let thread_id = thread_id.to_string();
        self.run_blocking(move |tm| {
            tm.delete_agent_conversation_instances_for_thread_inner(&thread_id)
        })
        .await
    }

    fn delete_agent_conversation_instances_for_thread_inner(
        &self,
        thread_id: &str,
    ) -> Result<u64, ThreadError> {
        let conn = self.lock_conn();
        let deleted = conn.execute(
            "DELETE FROM agent_conversation_instances WHERE thread_id = ?1",
            [thread_id],
        )?;
        Ok(deleted as u64)
    }

    pub async fn delete_thread_with_agent_conversations(
        self: &Arc<Self>,
        thread_id: &str,
    ) -> Result<bool, ThreadError> {
        let thread_id = thread_id.to_string();
        self.run_blocking(move |tm| tm.delete_thread_with_agent_conversations_inner(&thread_id))
            .await
    }

    fn delete_thread_with_agent_conversations_inner(
        &self,
        thread_id: &str,
    ) -> Result<bool, ThreadError> {
        let mut conn = self.lock_conn();
        let tx = conn.transaction()?;
        tx.execute("DROP TABLE IF EXISTS temp.thread_delete_ids", [])?;
        tx.execute(
            "CREATE TEMP TABLE thread_delete_ids (thread_id TEXT PRIMARY KEY)",
            [],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO thread_delete_ids (thread_id) VALUES (?1)",
            [thread_id],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO thread_delete_ids (thread_id)
             SELECT thread_id
             FROM thread_external_sessions
             WHERE external_session_id = ?1",
            [thread_id],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO thread_delete_ids (thread_id)
             SELECT s2.thread_id
             FROM thread_external_sessions s1
             JOIN thread_external_sessions s2
               ON s2.runtime = s1.runtime
              AND s2.external_session_id = s1.external_session_id
             WHERE s1.thread_id = ?1",
            [thread_id],
        )?;
        tx.execute(
            "DELETE FROM agent_conversation_instances
             WHERE thread_id IN (SELECT thread_id FROM thread_delete_ids)",
            [],
        )?;
        tx.execute(
            "DELETE FROM agent_external_events
             WHERE thread_id IN (SELECT thread_id FROM thread_delete_ids)",
            [],
        )?;
        let deleted = tx.execute(
            "DELETE FROM threads
             WHERE thread_id IN (SELECT thread_id FROM thread_delete_ids)",
            [],
        )?;
        tx.execute("DROP TABLE IF EXISTS temp.thread_delete_ids", [])?;
        tx.commit()?;
        Ok(deleted > 0)
    }

    fn row_to_agent_conversation_instance(
        row: &rusqlite::Row<'_>,
    ) -> rusqlite::Result<AgentConversationInstance> {
        let source = AgentConversationSource {
            kind: row.get(6)?,
            document_path: row.get(7)?,
            memo_id: row.get(8)?,
        };
        let role_memo_id: Option<String> = row.get(9)?;
        let role_name: Option<String> = row.get(10)?;
        let role = if role_memo_id.is_some() || role_name.is_some() {
            Some(AgentConversationRole {
                memo_id: role_memo_id,
                name: role_name,
            })
        } else {
            None
        };
        Ok(AgentConversationInstance {
            instance_id: row.get(0)?,
            agent_type: row.get(1)?,
            thread_title: row.get(2)?,
            thread_id: row.get(3)?,
            runtime_config: row.get(4)?,
            frozen_cwd: row.get(5)?,
            source,
            role,
            created_at: row.get(11)?,
            updated_at: row.get(12)?,
        })
    }
}
