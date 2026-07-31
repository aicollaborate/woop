use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::lock_utils::read_lock;

/// Wire-level identity of one authoritative memo content commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCommit {
    pub content_hash: String,
    pub revision: i64,
    pub change_id: String,
}

/// Single coordinator for every memo mutation source. Known application
/// writes and stable watcher observations both enter here immediately before
/// their event is published.
pub struct DocumentMutationCoordinator;

impl DocumentMutationCoordinator {
    pub fn commit(
        app: &AppHandle,
        memo_id: &str,
        notebook_id: &str,
        path: &Path,
    ) -> Option<DocumentCommit> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) => {
                tracing::warn!(
                    "failed to read memo bytes for revision commit {}: {error}",
                    path.display()
                );
                return None;
            }
        };
        let content_hash = format!("{:x}", Sha256::digest(&bytes));
        Self::commit_hash(app, memo_id, notebook_id, content_hash)
    }

    pub fn commit_deletion(
        app: &AppHandle,
        memo_id: &str,
        notebook_id: &str,
    ) -> Option<DocumentCommit> {
        Self::commit_hash(app, memo_id, notebook_id, "deleted".to_string())
    }

    fn commit_hash(
        app: &AppHandle,
        memo_id: &str,
        notebook_id: &str,
        content_hash: String,
    ) -> Option<DocumentCommit> {
        let change_id = uuid::Uuid::new_v4().to_string();
        let state = app.try_state::<crate::app::state::AppState>()?;
        let result = read_lock(&state.memo_file, "memo_file").commit_memo_content_revision(
            memo_id,
            notebook_id,
            &content_hash,
            &change_id,
        );
        match result {
            Ok(commit) => Some(DocumentCommit {
                content_hash: commit.state.content_hash,
                revision: commit.state.revision,
                change_id: commit.state.change_id,
            }),
            Err(error) => {
                tracing::warn!(
                    "failed to persist memo content revision {notebook_id}/{memo_id}: {error}"
                );
                None
            }
        }
    }
}
