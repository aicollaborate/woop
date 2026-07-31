//! Self-write suppression filter.
//!
//! Paths marked through `MemoWatcher::mark_self_write` are dropped for the TTL
//! window so one backend write can suppress multiple notify events.

use crate::watcher::event::{DropReason, FilterDecision, RawFsEvent};
use crate::watcher::filter::{FileRevision, Filter, FilterCtx, SELF_WRITE_TTL};

/// Suppress only the exact content revision captured by `mark_self_write`.
pub struct SelfWriteSuppressor;

impl Filter for SelfWriteSuppressor {
    fn decide(&self, event: &RawFsEvent, ctx: &mut FilterCtx) -> FilterDecision {
        let key = crate::watcher::path::normalize_for_compare(&event.path);
        let Ok(mut map) = ctx.recent_self_writes.lock() else {
            return FilterDecision::Pass;
        };
        // 顺手�?��过老条�?��SELF_WRITE_TTL (2s) 覆盖 IPC 命令结束 �?notify
        // 回调到达的间�? FSEvents 双触�?(macOS 把一�?fs::write 拆成
        // Keep both Metadata and Data events suppressed during the TTL, then
        // prune expired entries so the table stays bounded.
        map.retain(|_, mark| mark.marked_at.elapsed() < SELF_WRITE_TTL);

        // Keep the entry after an exact hit so duplicate FSEvents for the same
        // write are suppressed. A different revision invalidates it below.
        let current_revision = FileRevision::read(&event.path);
        let suppress = map.get(&key).is_some_and(|mark| {
            mark.expected_revision.is_some() && mark.expected_revision == current_revision
        });
        if suppress {
            tracing::debug!(
                "[SelfWriteSuppressor] HIT path={} key={} table_size={}",
                event.path.display(),
                key.display(),
                map.len(),
            );
            FilterDecision::Drop {
                reason: DropReason::SelfWriteSuppressed,
            }
        } else {
            // A later writer changed the same path during the TTL. The path
            // marker is stale, so it must not suppress this real update.
            map.remove(&key);
            tracing::debug!(
                "[SelfWriteSuppressor] MISS path={} key={} table_size={}",
                event.path.display(),
                key.display(),
                map.len(),
            );
            FilterDecision::Pass
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::watcher::filter::{FileRevision, SelfWriteMark};
    use std::time::Instant;

    fn marked_context(path: &std::path::Path) -> FilterCtx {
        let ctx = FilterCtx::new();
        ctx.recent_self_writes.lock().unwrap().insert(
            crate::watcher::path::normalize_for_compare(path),
            SelfWriteMark {
                marked_at: Instant::now(),
                expected_revision: FileRevision::read(path),
            },
        );
        ctx
    }

    #[test]
    fn suppresses_only_the_exact_marked_content_revision() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.md");
        std::fs::write(&path, "first revision").unwrap();
        let mut ctx = marked_context(&path);
        let event = RawFsEvent::new(crate::watcher::event::FsEventKind::Modify, path);

        assert!(matches!(
            SelfWriteSuppressor.decide(&event, &mut ctx),
            FilterDecision::Drop {
                reason: DropReason::SelfWriteSuppressed
            }
        ));
    }

    #[test]
    fn passes_a_new_revision_written_to_the_same_marked_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.md");
        std::fs::write(&path, "ui revision").unwrap();
        let mut ctx = marked_context(&path);
        std::fs::write(&path, "agent revision").unwrap();
        let event = RawFsEvent::new(crate::watcher::event::FsEventKind::Modify, path);

        assert!(matches!(
            SelfWriteSuppressor.decide(&event, &mut ctx),
            FilterDecision::Pass
        ));
    }
}
