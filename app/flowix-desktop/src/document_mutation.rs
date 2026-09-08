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

impl DocumentCommit {
    pub fn matches_content(&self, content: &str) -> bool {
        self.content_hash == format!("{:x}", Sha256::digest(content.as_bytes()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commit_identity_must_match_the_acknowledged_snapshot() {
        let commit = DocumentCommit {
            content_hash: format!("{:x}", Sha256::digest(b"first")),
            revision: 1,
            change_id: "change".into(),
        };
        assert!(commit.matches_content("first"));
        assert!(!commit.matches_content("second"));
    }
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
    ) -> Result<Option<DocumentCommit>, ()> {
        let Some(state) = app.try_state::<crate::app::state::AppState>() else {
            return Ok(None);
        };
        let store = read_lock(&state.memo_file, "memo_file");
        let Ok(expected) = store.read_memo_content_revision(memo_id) else {
            return Ok(None);
        };
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) => {
                tracing::warn!(
                    "failed to read memo bytes for revision commit {}: {error}",
                    path.display()
                );
                return Ok(None);
            }
        };
        let content_hash = format!("{:x}", Sha256::digest(&bytes));
        Self::commit_hash(
            &store,
            memo_id,
            notebook_id,
            content_hash,
            expected.as_ref(),
        )
    }

    pub fn commit_deletion(
        app: &AppHandle,
        memo_id: &str,
        notebook_id: &str,
    ) -> Result<Option<DocumentCommit>, ()> {
        let Some(state) = app.try_state::<crate::app::state::AppState>() else {
            return Ok(None);
        };
        let store = read_lock(&state.memo_file, "memo_file");
        let Ok(expected) = store.read_memo_content_revision(memo_id) else {
            return Ok(None);
        };
        Self::commit_hash(
            &store,
            memo_id,
            notebook_id,
            "deleted".to_string(),
            expected.as_ref(),
        )
    }

    fn commit_hash(
        store: &flowix_core::memo_file::MemoFile,
        memo_id: &str,
        notebook_id: &str,
        content_hash: String,
        expected: Option<&flowix_core::memo_file::MemoContentRevision>,
    ) -> Result<Option<DocumentCommit>, ()> {
        let change_id = uuid::Uuid::new_v4().to_string();
        let result = store.commit_memo_content_revision_if_current(
            memo_id,
            notebook_id,
            &content_hash,
            &change_id,
            expected,
        );
        match result {
            Ok(Some(commit)) => Ok(Some(DocumentCommit {
                content_hash: commit.state.content_hash,
                revision: commit.state.revision,
                change_id: commit.state.change_id,
            })),
            Ok(None) => Err(()),
            Err(error) => {
                tracing::warn!(
                    "failed to persist memo content revision {notebook_id}/{memo_id}: {error}"
                );
                Ok(None)
            }
        }
    }
}
