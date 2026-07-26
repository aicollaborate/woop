use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use super::{AgentManager, RunInfo};

pub(super) const STUCK_THRESHOLD: u32 = 5;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct CallKey {
    pub(super) tool_name: String,
    pub(super) args_hash: u64,
}

pub(super) struct InFlightChat {
    pub(super) cancel: Arc<AtomicBool>,
    pub(super) started_at: i64,
    pub(super) run_id: String,
}

pub(super) fn compute_call_key(tool_name: &str, arguments: &str) -> CallKey {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    arguments.hash(&mut hasher);
    CallKey {
        tool_name: tool_name.to_string(),
        args_hash: hasher.finish(),
    }
}

impl AgentManager {
    /// 记录�?�� (tool, args) 调用, 返回�?��达到熔断阈值�?    /// 调用次数 > STUCK_THRESHOLD 时返�?true, �?6 次同调用即触发�?
    pub(super) async fn record_tool_call(
        &self,
        thread_id: &str,
        tool_name: &str,
        arguments: &str,
    ) -> bool {
        let key = compute_call_key(tool_name, arguments);
        let mut attempts = self.tool_call_attempts.write().await;
        let thread_attempts = attempts.entry(thread_id.to_string()).or_default();
        let count = thread_attempts.entry(key).or_insert(0);
        *count += 1;
        *count > STUCK_THRESHOLD
    }

    /// 清空�?thread 的累认?数。下�?chat_stream 入口会兜底再调一�?
    /// 这里主�?�?LLM 给最终回�?的清空信号使用�?
    pub(super) async fn clear_tool_call_attempts(&self, thread_id: &str) {
        let mut attempts = self.tool_call_attempts.write().await;
        attempts.remove(thread_id);
    }

    /// 删除 thread 时清�?AgentManager 内与�?thread 关联的所�?in-memory 状态�?    /// 解决 "thread_delete �?ThreadManager 但不通知 AgentManager" 造成�?    /// read_snapshots / tool_call_attempts HashMap 长期泄露�?    /// 多�?调用幂等, 不存在的 thread_id 静默 no-op�?
    pub async fn cleanup_thread(&self, thread_id: &str) {
        let mut snapshots = self.read_snapshots.write().await;
        snapshots.remove(thread_id);
        let mut attempts = self.tool_call_attempts.write().await;
        attempts.remove(thread_id);
    }

    /// 查�?当前所�?in-flight chat ── 供前�?`agent_running_threads`
    /// IPC 调用。前�?��动时调用一�? seed �?`threadStates[].isLoading`�?    ///
    /// 返回值映�?`thread_id -> { started_at, current_tool }` ──
    /// `current_tool` 暂时�?`None`, 因为 ReAct �?���?`last_tool_name`
    /// �?��数局部变�? 不在 manager state 里。Phase 1 不需�? �?    /// UI 真用上再补一�?in-flight tool 镜像�?
    pub async fn running_threads(&self) -> HashMap<String, RunInfo> {
        let in_flight = self.in_flight.lock().await;
        in_flight
            .iter()
            .map(|(tid, run)| {
                (
                    tid.clone(),
                    RunInfo::active(
                        run.started_at,
                        None,
                        Some("flowix"),
                        Some(run.run_id.clone()),
                        Some(tid.clone()),
                        None,
                    ),
                )
            })
            .collect()
    }

    pub(super) async fn unregister_in_flight_if_current(
        &self,
        thread_id: &str,
        cancel: &Arc<AtomicBool>,
    ) {
        let mut in_flight = self.in_flight.lock().await;
        let is_current_run = in_flight
            .get(thread_id)
            .map(|run| Arc::ptr_eq(&run.cancel, cancel))
            .unwrap_or(false);
        if is_current_run {
            in_flight.remove(thread_id);
        }
    }

    pub async fn stop_chat(&self, thread_id: &str, _run_id: Option<&str>) -> bool {
        let in_flight = {
            let mut registry = self.in_flight.lock().await;
            registry.remove(thread_id)
        };
        match in_flight {
            Some(run) => {
                run.cancel.store(true, Ordering::Release);
                tracing::info!(
                    "[Agent] stop_chat signalled cancel for thread_id: {}",
                    thread_id
                );
                true
            }
            None => false,
        }
    }
}
