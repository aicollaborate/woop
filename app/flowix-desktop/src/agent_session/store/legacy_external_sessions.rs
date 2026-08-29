//! Read-only compatibility for pre-provider-table session bindings.
//!
//! Normal runtime writes must not call this module. Startup migrations backfill
//! provider branches; these helpers only keep partially migrated databases and
//! deletion aliases readable for the minimum compatibility window.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};

use crate::agent_session::error::ThreadError;

pub(super) fn list_bindings(
    conn: &Connection,
    runtime: &str,
) -> Result<HashMap<String, String>, ThreadError> {
    let mut stmt = conn.prepare(
        "SELECT external_session_id, thread_id
         FROM thread_external_sessions
         WHERE runtime = ?1
         ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map([runtime], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    Ok(rows.collect::<Result<HashMap<_, _>, _>>()?)
}

pub(super) fn find_product_thread(
    conn: &Connection,
    runtime: &str,
    external_id: &str,
) -> Result<Option<String>, ThreadError> {
    Ok(conn
        .query_row(
            "SELECT thread_id FROM thread_external_sessions
             WHERE runtime = ?1 AND external_session_id = ?2
             ORDER BY updated_at DESC LIMIT 1",
            params![runtime, external_id],
            |row| row.get(0),
        )
        .optional()?)
}

pub(super) fn find_external_id(
    conn: &Connection,
    runtime: &str,
    thread_id: &str,
) -> Result<Option<String>, ThreadError> {
    Ok(conn
        .query_row(
            "SELECT external_session_id FROM thread_external_sessions
             WHERE thread_id = ?1 AND runtime = ?2",
            params![thread_id, runtime],
            |row| row.get(0),
        )
        .optional()?)
}
