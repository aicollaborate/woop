use crate::agent_session::{error::ThreadError, ThreadManager};

pub(super) fn delete_non_claude_events(manager: &ThreadManager) -> Result<usize, ThreadError> {
    let conn = manager.lock_conn();
    Ok(conn.execute(
        "DELETE FROM agent_external_events WHERE runtime <> 'claude'",
        [],
    )?)
}

pub(super) fn checkpoint_wal(manager: &ThreadManager) -> Result<(), ThreadError> {
    manager.checkpoint_wal()
}

#[cfg(test)]
mod tests {
    use super::delete_non_claude_events;
    use crate::agent_session::ThreadManager;

    #[test]
    fn deletes_non_claude_events_but_preserves_claude_events() {
        let dir = tempfile::tempdir().unwrap();
        let manager = ThreadManager::new(dir.path().join("thread.db")).unwrap();
        let conn = manager.lock_conn();
        conn.execute(
            "INSERT INTO threads (thread_id, agent_id, title, created_at, updated_at)
             VALUES ('maintenance-thread', 'claude', 'Maintenance', 1, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO agent_external_events
             (runtime, thread_id, normalized_json, created_at)
             VALUES ('claude', 'maintenance-thread', '{}', 1),
                    ('codex', 'maintenance-thread', '{}', 1),
                    ('opencode', 'maintenance-thread', '{}', 1)",
            [],
        )
        .unwrap();
        drop(conn);

        assert_eq!(delete_non_claude_events(&manager).unwrap(), 2);
        let conn = manager.lock_conn();
        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agent_external_events WHERE runtime = 'claude'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 1);
    }
}
