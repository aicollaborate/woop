//! ThreadManager error type. `Sqlite` variant auto-wraps every
//! `rusqlite::Error` call site via `#[from]`; `NotFound` is
//! constructed explicitly by store-level methods that want
//! callers to distinguish a missing row from a SQLite failure.

#[derive(Debug, thiserror::Error)]
pub enum ThreadError {
    #[error("thread database error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("thread not found: {0}")]
    NotFound(String),
    #[error("conversation thread already belongs to another instance: thread={thread_id}, instance={instance_id}")]
    ConversationThreadConflict { thread_id: String, instance_id: String },
    #[error("thread store join error: {0}")]
    Join(String),
}
