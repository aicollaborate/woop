//! Self-write suppression filter.
//!
//! Paths marked through `MemoWatcher::mark_self_write` are dropped for the TTL
//! window so one backend write can suppress multiple notify events.

use crate::watcher::event::{DropReason, FilterDecision, RawFsEvent};
use crate::watcher::filter::{Filter, FilterCtx, SELF_WRITE_TTL};

/// �?2: �?��抑制。`mark_self_write` 写过的路�? 命中即吞�?
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
        map.retain(|_, t| t.elapsed() < SELF_WRITE_TTL);

        // �?remove 表项 —FSEvents 双触发两条事件都要吞, remove 后�?二条
        // �?MISS 漏到 processor �?"外部�?��" �?���?表项由上面的 retain
        // �?2s TTL 兜底清理, 不会无限占位�?
        if map.contains_key(&key) {
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
