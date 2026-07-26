use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::Value;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Child;
#[cfg(windows)]
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::agent_flowix::{AgentChunk, AgentUserMessage, RunInfo};
use crate::agent_session::{NewAgentExternalEvent, ThreadManager};
use crate::events as dispatcher;
use crate::runtime_log;

/// Add the extra Flowix workspace roots to runtimes that do not expose a
/// stable `--add-dir`-style CLI flag. The process already runs in `cwd`; this
/// note makes every other authorized root discoverable to the agent without
/// altering the user message persisted in Flowix history.
pub fn append_workspace_context(prompt: &str, cwd: &Path, workspace_paths: &[String]) -> String {
    let cwd = cwd
        .to_string_lossy()
        .trim_end_matches(['/', '\\'])
        .to_string();
    let mut seen = std::collections::HashSet::new();
    let additional: Vec<String> = workspace_paths
        .iter()
        .map(|path| path.trim().trim_end_matches(['/', '\\']).to_string())
        .filter(|path| !path.is_empty() && path != &cwd && Path::new(path).is_dir())
        .filter(|path| seen.insert(path.clone()))
        .collect();

    if additional.is_empty() {
        return prompt.to_string();
    }

    format!(
        "{prompt}\n\n[Flowix workspace context]\nThe user has attached these additional local reference directories. Read and search them when relevant to the request:\n{}",
        additional
            .iter()
            .map(|path| format!("- {path}"))
            .collect::<Vec<_>>()
            .join("\n")
    )
}

/// One live external-agent child process per `thread_id`.
///
/// Codex / Claude Code / `simple_cli` all fall under this shape: a long-lived
/// process whose stdout is line-streamed as JSON events. Consolidating the
/// state here makes run-id / kill / stdout-cap semantics single-sourced.
#[derive(Clone)]
pub struct ExternalRunRegistry {
    agent_type: &'static str,
    current_tool: &'static str,
    children: Arc<Mutex<HashMap<String, ExternalRunningChild>>>,
}

pub struct ExternalRunningChild {
    pub child: Child,
    pub started_at: i64,
    pub last_event_at: i64,
    pub run_id: Option<String>,
    pub session_id: Option<String>,
    /// Shared one-shot flag between the streaming task that spawned this child
    /// and anyone that may end the run out-of-band (`stop_chat`, the idle
    /// watchdog). Whoever wins the `compare_exchange(false 鈫?true)` race is
    /// the sole emitter of `AgentChunk::StreamEnd`; every other path sees the
    /// flag set and skips. This is the *only* "StreamEnd already emitted"
    /// mechanism 鈹€鈹€ there is no parallel bool. It lets `stop_chat` /
    /// watchdog converge the UI immediately instead of waiting on the
    /// streaming task to notice the child died (which can hang when
    /// grandchildren still hold the stdout write end).
    pub stream_end_emitted: Arc<AtomicBool>,
}

/// State shared by the streaming tail, `stop_chat`, and the idle watchdog for
/// one external CLI invocation. Creating it in the registry keeps run-id
/// normalization and the one-shot `StreamEnd` flag identical across vendors.
pub struct ExternalRunStart {
    pub run_id: String,
    pub stream_end_emitted: Arc<AtomicBool>,
}

/// Minimal terminal state returned after the registry has claimed and killed
/// a child. Runtime-specific managers still decide how terminal events are
/// persisted; the process lifecycle itself is single-sourced here.
pub struct ExternalStoppedRun {
    pub run_id: String,
    pub stream_end_emitted: Arc<AtomicBool>,
}

#[derive(Clone, Debug)]
pub struct ExternalWatchdogFinalizedRun {
    pub thread_id: String,
    pub run_id: Option<String>,
    pub reason: Option<String>,
}

impl ExternalRunRegistry {
    pub fn new(agent_type: &'static str, current_tool: &'static str) -> Self {
        Self {
            agent_type,
            current_tool,
            children: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    #[cfg(test)]
    async fn insert(
        &self,
        thread_id: String,
        child: Child,
        run_id: Option<String>,
        stream_end_emitted: Arc<AtomicBool>,
    ) {
        let mut children = self.children.lock().await;
        let now = chrono::Utc::now().timestamp_millis();
        children.insert(
            thread_id,
            ExternalRunningChild {
                child,
                started_at: now,
                last_event_at: now,
                run_id,
                session_id: None,
                stream_end_emitted,
            },
        );
    }

    pub async fn try_insert(
        &self,
        thread_id: String,
        child: Child,
        run_id: Option<String>,
        stream_end_emitted: Arc<AtomicBool>,
    ) -> Result<(), Child> {
        let mut children = self.children.lock().await;
        if children.contains_key(&thread_id) {
            return Err(child);
        }
        let now = chrono::Utc::now().timestamp_millis();
        children.insert(
            thread_id,
            ExternalRunningChild {
                child,
                started_at: now,
                last_event_at: now,
                run_id,
                session_id: None,
                stream_end_emitted,
            },
        );
        Ok(())
    }

    pub async fn touch(&self, thread_id: &str, expected_run_id: Option<&str>) {
        let mut children = self.children.lock().await;
        let Some(running) = children.get_mut(thread_id) else {
            return;
        };
        if expected_run_id.is_some() && running.run_id.as_deref() != expected_run_id {
            return;
        }
        running.last_event_at = chrono::Utc::now().timestamp_millis();
    }

    pub async fn set_session_id(
        &self,
        thread_id: &str,
        expected_run_id: Option<&str>,
        session_id: String,
    ) {
        let mut children = self.children.lock().await;
        let Some(running) = children.get_mut(thread_id) else {
            return;
        };
        if expected_run_id.is_some() && running.run_id.as_deref() != expected_run_id {
            return;
        }
        running.session_id = Some(session_id);
        running.last_event_at = chrono::Utc::now().timestamp_millis();
    }

    pub async fn remove(&self, thread_id: &str) -> Option<ExternalRunningChild> {
        let mut children = self.children.lock().await;
        children.remove(thread_id)
    }

    /// Prepare the shared lifecycle state before a runtime emits StreamStart.
    /// A still-live entry is rejected first, so callers never briefly expose a
    /// new loading state for an invocation that cannot start.
    pub async fn prepare_start(
        &self,
        thread_id: &str,
        provided_run_id: Option<&str>,
    ) -> Result<ExternalRunStart, String> {
        if let Some(reason) = self.reap_stale(thread_id).await {
            return Err(reason);
        }
        Ok(ExternalRunStart {
            run_id: resolve_run_id(thread_id, provided_run_id),
            stream_end_emitted: Arc::new(AtomicBool::new(false)),
        })
    }

    #[cfg(test)]
    async fn contains(&self, thread_id: &str) -> bool {
        let children = self.children.lock().await;
        children.contains_key(thread_id)
    }

    /// Make room for a new chat on `thread_id`.
    ///
    ///   * No entry, or the previous child has already exited (`try_wait`
    ///     returns `Some(_)`): returns `None`. The entry has been dropped
    ///     in the exited case; the caller can proceed.
    ///   * Previous child is still running, or `try_wait` errored: returns
    ///     `Some(reason)` and restores the entry. The caller should refuse.
    ///
    /// Without this, a child that crashed (SIGKILL / OOM / broken pipe)
    /// leaves a zombie entry that every later `contains`-style guard
    /// reports as "already running" 鈥?the thread is permanently blocked
    /// until the watchdog's 60s+ idle reaper finally sweeps it. Calling
    /// this at `chat_stream` entry keeps the registry honest.
    ///
    /// Implementation note: the entire remove 鈫?try_wait 鈫?maybe-insert
    /// sequence runs under one `children` lock acquisition. `try_wait` is
    /// non-blocking per its docs, so holding the mutex is safe; doing the
    /// operation across two lock acquisitions would let a concurrent
    /// `chat_stream` slip a fresh child into the registry between our
    /// `remove` and `insert`, and our restore would clobber it.
    pub async fn reap_stale(&self, thread_id: &str) -> Option<String> {
        let mut children = self.children.lock().await;
        let Some(mut running) = children.remove(thread_id) else {
            return None;
        };
        match running.child.try_wait() {
            Ok(Some(_status)) => {
                tracing::info!(
                    "[{}] reaped stale child for {} before new chat",
                    self.current_tool,
                    thread_id
                );
                None
            }
            Ok(None) => {
                children.insert(thread_id.to_string(), running);
                Some(format!(
                    "{} is already running for this thread",
                    self.current_tool
                ))
            }
            Err(err) => {
                tracing::warn!(
                    "[{}] try_wait failed for {}: {err}; treating as live",
                    self.current_tool,
                    thread_id
                );
                children.insert(thread_id.to_string(), running);
                Some(format!(
                    "{} child state unknown; refusing to overlap",
                    self.current_tool
                ))
            }
        }
    }

    pub async fn remove_if_run_id(
        &self,
        thread_id: &str,
        expected_run_id: Option<&str>,
    ) -> Option<ExternalRunningChild> {
        let mut children = self.children.lock().await;
        let Some(running) = children.get(thread_id) else {
            return None;
        };
        if running.run_id.as_deref() != expected_run_id {
            return None;
        }
        children.remove(thread_id)
    }

    /// Remove and terminate one run. `lookup_thread_id` is the registry key;
    /// `event_thread_id` is the product thread used by terminal events and as
    /// the run-id fallback. Codex/Claude may retry with a mapped local thread
    /// while keeping the original external-session id as the event target.
    pub async fn stop_run(
        &self,
        lookup_thread_id: &str,
        event_thread_id: &str,
        expected_run_id: Option<&str>,
        process_label: &str,
    ) -> Option<ExternalStoppedRun> {
        let running = match expected_run_id {
            Some(run_id) => self.remove_if_run_id(lookup_thread_id, Some(run_id)).await,
            None => self.remove(lookup_thread_id).await,
        };
        let mut running = running?;
        kill_child_tree(&mut running.child, process_label, event_thread_id).await;
        Some(ExternalStoppedRun {
            run_id: running
                .run_id
                .unwrap_or_else(|| event_thread_id.to_string()),
            stream_end_emitted: running.stream_end_emitted,
        })
    }

    pub async fn kill_all(&self, process_label: &str) -> usize {
        let running = {
            let mut children = self.children.lock().await;
            children.drain().collect::<Vec<_>>()
        };
        let count = running.len();
        for (thread_id, mut running) in running {
            kill_child_tree(&mut running.child, process_label, &thread_id).await;
        }
        count
    }

    pub async fn reap_inactive(
        &self,
        idle_timeout_ms: i64,
        process_label: &str,
    ) -> Vec<ExternalWatchdogFinalizedRun> {
        let now = chrono::Utc::now().timestamp_millis();
        let mut finalized = Vec::new();
        let mut idle_children = Vec::new();

        {
            let mut children = self.children.lock().await;
            let thread_ids = children.keys().cloned().collect::<Vec<_>>();
            for thread_id in thread_ids {
                enum Decision {
                    Keep,
                    Exited(bool, String),
                    InspectFailed(String),
                    Idle,
                    Missing,
                }

                let decision = match children.get_mut(&thread_id) {
                    Some(running) => {
                        let is_idle = idle_timeout_ms > 0
                            && now.saturating_sub(running.last_event_at) >= idle_timeout_ms;
                        if !is_idle {
                            Decision::Keep
                        } else {
                            match running.child.try_wait() {
                                Ok(Some(status)) => {
                                    Decision::Exited(status.success(), status.to_string())
                                }
                                Ok(None) => Decision::Idle,
                                Err(err) => Decision::InspectFailed(err.to_string()),
                            }
                        }
                    }
                    None => Decision::Missing,
                };

                match decision {
                    Decision::Keep | Decision::Missing => {}
                    Decision::Exited(success, status) => {
                        if let Some(running) = children.remove(&thread_id) {
                            // 在锁内、kill 之前�?StreamEnd slot ── �?tail /
                            // stop_chat 已先发过 (Exited: child 已�?, tail �?���?                            // 观察�?EOF �?CAS), 跳过�?run, 不双发也不�?盖�?                            // Idle: child 还活着, tail 必然还阻塞在 read, 这里
                            // �?��性赢, 避免杀进程�?tail 抢赢导致 idle-timeout
                            // reason + persist 丢失�?
                            if !claim_stream_end_once(&running.stream_end_emitted) {
                                continue;
                            }
                            let reason = (!success).then(|| format!("process_exited: {status}"));
                            finalized.push(ExternalWatchdogFinalizedRun {
                                thread_id,
                                run_id: running.run_id,
                                reason,
                            });
                        }
                    }
                    Decision::InspectFailed(err) => {
                        if let Some(running) = children.remove(&thread_id) {
                            if !claim_stream_end_once(&running.stream_end_emitted) {
                                continue;
                            }
                            finalized.push(ExternalWatchdogFinalizedRun {
                                thread_id,
                                run_id: running.run_id,
                                reason: Some(format!("process_watchdog_failed: {err}")),
                            });
                        }
                    }
                    Decision::Idle => {
                        if let Some(running) = children.remove(&thread_id) {
                            if !claim_stream_end_once(&running.stream_end_emitted) {
                                continue;
                            }
                            idle_children.push((thread_id, running));
                        }
                    }
                }
            }
        }

        for (thread_id, mut running) in idle_children {
            kill_child_tree(&mut running.child, process_label, &thread_id).await;
            finalized.push(ExternalWatchdogFinalizedRun {
                thread_id,
                run_id: running.run_id,
                reason: Some(format!("watchdog_idle_timeout_ms={idle_timeout_ms}")),
            });
        }

        finalized
    }

    pub async fn running_threads(&self) -> HashMap<String, RunInfo> {
        let children = self.children.lock().await;
        children
            .iter()
            .map(|(thread_id, running)| {
                let canonical_thread_id = running
                    .session_id
                    .clone()
                    .unwrap_or_else(|| thread_id.clone());
                (
                    canonical_thread_id,
                    RunInfo::active(
                        running.started_at,
                        Some(self.current_tool),
                        Some(self.agent_type),
                        running.run_id.clone(),
                        Some(thread_id.clone()),
                        running.session_id.clone(),
                    ),
                )
            })
            .collect()
    }
}

/// Build a run id when the caller did not provide one. Format keeps it
/// grep-friendly in `runtime_log::agent.log`: `{thread_id}-{unix_millis}`.
pub fn create_run_id(thread_id: &str) -> String {
    format!("{}-{}", thread_id, chrono::Utc::now().timestamp_millis())
}

/// Resolve the run id for a chat invocation. Frontend may attach an id (used
/// by the thread-card UI to disambiguate overlapping runs on the same
/// thread); otherwise we mint one. Trimmed-empty values fall through to the
/// generated branch so callers never see a blank `run_id`.
pub fn resolve_run_id(thread_id: &str, provided_run_id: Option<&str>) -> String {
    provided_run_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| create_run_id(thread_id))
}

/// Emit an `AgentChunk` on `agent-chunk` with the run id injected at the
/// payload's top level. Frontend `chat-store` keys live state by
/// `(thread_id, run_id)` so emit paths that bypass this helper (e.g. emit
/// before the run id has been resolved) silently break the discriminator.
///
/// Logs `codex_emit` / `claude_emit`-shaped records on serialize / dispatch
/// failure so missing-the-front-door bugs don't disappear silently.
pub fn emit_chunk_with_run_id(
    app_handle: &tauri::AppHandle,
    chunk: &AgentChunk,
    agent_type: &'static str,
    run_id: &str,
) {
    let mut payload = match serde_json::to_value(chunk) {
        Ok(value) => value,
        Err(err) => {
            runtime_log::record_agent_event(
                "warn",
                "agent_emit",
                "agent.emit_serialize_failed",
                "Failed to serialize agent chunk",
                Some(chunk.thread_id()),
                Some(agent_type),
                Some(serde_json::json!({
                    "chunk_kind": chunk.kind(),
                    "run_id": run_id,
                    "error": err.to_string(),
                })),
            );
            return;
        }
    };
    if let Some(object) = payload.as_object_mut() {
        object.insert("run_id".to_string(), Value::String(run_id.to_string()));
        object.insert(
            "agent_type".to_string(),
            Value::String(agent_type.to_string()),
        );
    }
    if !dispatcher::emit_to(app_handle, "agent-chunk", payload) {
        runtime_log::record_agent_event(
            "warn",
            "agent_emit",
            "agent.emit_failed",
            "Failed to emit agent chunk",
            Some(chunk.thread_id()),
            Some(agent_type),
            Some(serde_json::json!({
                "chunk_kind": chunk.kind(),
                "run_id": run_id,
            })),
        );
        tracing::warn!(
            chunk_kind = chunk.kind(),
            thread_id = chunk.thread_id(),
            run_id = run_id,
            agent_type = agent_type,
            "emit agent-chunk failed"
        );
    }
}

pub async fn persist_external_chunk(
    thread_manager: &Arc<ThreadManager>,
    agent_type: &'static str,
    chunk: &AgentChunk,
    run_id: &str,
    raw_json: Option<&str>,
) {
    let payload_json = match chunk_payload_json(chunk, agent_type, run_id) {
        Some(payload) => payload,
        None => return,
    };
    let event = NewAgentExternalEvent {
        runtime: agent_type.to_string(),
        thread_id: chunk.thread_id().to_string(),
        normalized_json: payload_json,
        raw_json: raw_json
            .filter(|_| external_event_raw_json_enabled(agent_type))
            .map(str::to_string),
        created_at: None,
    };

    if let Err(err) = thread_manager.insert_agent_external_event(event).await {
        runtime_log::record_agent_event(
            "warn",
            "agent_events",
            "agent.event_persist_failed",
            "Failed to persist external agent stream event",
            Some(chunk.thread_id()),
            Some(agent_type),
            Some(serde_json::json!({
                "run_id": run_id,
                "chunk_kind": chunk.kind(),
                "error": err.to_string(),
            })),
        );
    }
}

pub async fn persist_and_emit_external_chunk(
    app_handle: &tauri::AppHandle,
    thread_manager: &Arc<ThreadManager>,
    agent_type: &'static str,
    chunk: &AgentChunk,
    run_id: &str,
    raw_json: Option<&str>,
) {
    persist_external_chunk(thread_manager, agent_type, chunk, run_id, raw_json).await;
    emit_chunk_with_run_id(app_handle, chunk, agent_type, run_id);
}

fn chunk_payload_json(
    chunk: &AgentChunk,
    agent_type: &'static str,
    run_id: &str,
) -> Option<String> {
    let mut payload = serde_json::to_value(chunk).ok()?;
    if let Value::Object(object) = &mut payload {
        object.insert("run_id".to_string(), Value::String(run_id.to_string()));
        object.insert(
            "agent_type".to_string(),
            Value::String(agent_type.to_string()),
        );
    }
    serde_json::to_string(&payload).ok()
}

fn external_event_raw_json_enabled(agent_type: &str) -> bool {
    let agent_key = agent_type
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect::<String>();

    env_bool(&format!("FLOWIX_{agent_key}_RAW_JSON"))
        .or_else(|| env_bool(&format!("FLOWIX_{agent_key}_DIAGNOSTICS")))
        .or_else(|| env_bool("FLOWIX_EXTERNAL_AGENT_RAW_JSON"))
        .or_else(|| env_bool("FLOWIX_EXTERNAL_AGENT_DIAGNOSTICS"))
        .unwrap_or_else(default_raw_json_enabled)
}

fn default_raw_json_enabled() -> bool {
    cfg!(debug_assertions)
}

fn env_bool(name: &str) -> Option<bool> {
    std::env::var(name).ok().map(|value| parse_env_bool(&value))
}

fn parse_env_bool(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

/// Reason string `stop_chat` attaches to its `StreamEnd`. The frontend
/// (`run-lifecycle::USER_STOPPED_REASON`) maps this to `cancelled` status 鈹€鈹€
/// a user-initiated stop is never `failed` / `completed`. Kept in sync by name
/// + value; changing one side without the other breaks the status mapping.
pub const USER_STOPPED_REASON: &str = "user_stopped";

/// Atomically claim the "StreamEnd has been emitted" slot for a run. First
/// caller wins (`true`); everyone else (`stop_chat`, streaming tail, watchdog)
/// gets `false` and must skip. This is the single chokepoint that prevents
/// double `StreamEnd` 鈹€鈹€ there is no parallel "already emitted" bool.
pub fn claim_stream_end_once(stream_end_emitted: &Arc<AtomicBool>) -> bool {
    stream_end_emitted
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

/// Claim the slot via [`claim_stream_end_once`] and, on a win, emit
/// `AgentChunk::StreamEnd`. Returns whether this caller emitted.
///
/// Callers:
///   * `*CliManager::stop_chat` 鈹€鈹€ reason `Some(USER_STOPPED_REASON)`
///   * the streaming `tokio::spawn` tail 鈹€鈹€ reason `None` (clean) or the run error
///
/// The idle watchdog does NOT use this 鈹€鈹€ it must emit an `Error` chunk
/// *before* `StreamEnd`, and it must claim *before* killing the child (else
/// the tail can race ahead and emit a bare `completed`). So `reap_inactive`
/// calls [`claim_stream_end_once`] directly under the children lock (before
/// `kill_child_tree`), and `reap_inactive_runs` then emits `Error` +
/// `StreamEnd` + persist for the runs that won the claim.
pub fn emit_stream_end_once(
    app_handle: &tauri::AppHandle,
    thread_id: &str,
    run_id: &str,
    agent_type: &'static str,
    reason: Option<String>,
    stream_end_emitted: &Arc<AtomicBool>,
) -> bool {
    if claim_stream_end_once(stream_end_emitted) {
        emit_chunk_with_run_id(
            app_handle,
            &AgentChunk::StreamEnd {
                thread_id: thread_id.to_string(),
                reason,
            },
            agent_type,
            run_id,
        );
        true
    } else {
        false
    }
}

/// Pick the external-CLI session id for a `chat_stream` invocation.
///
/// Decision order (first hit wins):
///   * `external_session_id_hint` 鈥?when the frontend thread id is itself a
///     provider-format session id (e.g. a Codex / Claude UUID pasted as a
///     thread id, or an `codex-local-...` placeholder resolved to one),
///     resume that session.
///   * `mapped_session_id` 鈥?otherwise trust the SQLite
///     `thread_external_sessions` mapping created when the thread first ran.
///
/// If a CLI process already produced a session id for this thread, we
///     resume it instead of starting a new one.
///
/// UI locks cwd / workspace dirs at first message time, so cwd drift
/// mid-conversation can't happen; we don't gate resume on cwd anymore.
/// (The previous runtime_key check used to be the source of a silent
/// post-restart fork 鈥?the in-memory key was wiped, so the comparison
/// always mismatched and we started a fresh session every cold start.)
pub fn select_external_session_for_runtime(
    mapped_session_id: Option<String>,
    external_session_id_hint: Option<String>,
) -> Option<String> {
    external_session_id_hint.or(mapped_session_id)
}

/// Resolve the working directory for an external CLI run, freezing it on the
/// first turn so it never drifts mid-conversation.
///
/// Decision order:
///   1. An optional runtime-owned authoritative cwd (for example, the cwd in a
///      Claude resume file). It also repairs a stale persisted value.
///   2. `frozen_cwd` persisted in `agent_conversation_instances` on a prior
///      turn. After the first message the cwd stops tracking the live notebook.
///   3. The runtime-specific `resolver` (IPC `runtime_config.{runtime}.cwd`
///      -> session-file cwd for claude/codex -> `None`). No process-cwd
///      fallback: if nothing resolves we fail loudly instead of silently
///      launching the CLI in `/`.
///
/// On branch (3) the resolved cwd is persisted so every future turn takes
/// branch (2). Persistence is best-effort - a DB failure is logged but does
/// not abort the run (the cwd is still valid for this turn).
pub async fn resolve_and_freeze_runtime_cwd(
    thread_manager: &Arc<ThreadManager>,
    thread_id: &str,
    resolver: impl Fn(&AgentUserMessage, Option<&str>) -> Option<PathBuf>,
    message: &AgentUserMessage,
    session_id: Option<&str>,
    authoritative_cwd: Option<&std::path::Path>,
) -> Result<PathBuf, String> {
    if let Some(authoritative) = authoritative_cwd.filter(|cwd| cwd.is_dir()) {
        let authoritative = authoritative.to_path_buf();
        if thread_manager
            .read_frozen_cwd(thread_id)
            .await
            .ok()
            .flatten()
            .as_ref()
            != Some(&authoritative)
        {
            if let Err(err) = thread_manager
                .upsert_frozen_cwd(thread_id, &authoritative)
                .await
            {
                tracing::warn!("failed to persist authoritative cwd for {thread_id}: {err}");
            }
        }
        return Ok(authoritative);
    }
    if let Ok(Some(frozen)) = thread_manager.read_frozen_cwd(thread_id).await {
        if frozen.is_dir() {
            return Ok(frozen);
        }
    }
    let cwd = resolver(message, session_id)
        .filter(|c| c.is_dir())
        .ok_or_else(|| {
            "Agent working directory unavailable; open a notebook or pick a folder".to_string()
        })?;
    if let Err(err) = thread_manager.upsert_frozen_cwd(thread_id, &cwd).await {
        tracing::warn!("failed to persist frozen cwd for {thread_id}: {err}");
    }
    Ok(cwd)
}

/// Hard cap (in bytes) on a single line of stdout read from an external CLI.
/// Without this, a single tool output that happens to land on a child's
/// stdout without a trailing newline 鈥?e.g. a giant heredoc 鈥?would force the
/// reader to accumulate the whole payload in memory before parsing. 512 KiB
/// covers every realistic tool result; anything larger goes through the
/// truncated path and is recorded in `runtime_log`.
pub const MAX_STDOUT_LINE_BYTES: usize = 512 * 1024;

/// Read a single line from a stdout-style async reader with a hard byte cap.
/// Returns `Ok(None)` at clean EOF, `Ok(Some((line, truncated)))` otherwise.
/// `truncated == true` means the source line exceeded the cap and the
/// returned string is the cap-sized prefix; the reader's internal cursor has
/// been advanced past the newline (if any) so subsequent calls resume cleanly.
pub async fn read_capped_line<R>(
    reader: &mut R,
    max_bytes: usize,
) -> Result<Option<(String, bool)>, String>
where
    R: AsyncBufRead + Unpin,
{
    let mut out = Vec::new();
    let mut truncated = false;
    loop {
        let available = reader.fill_buf().await.map_err(|e| e.to_string())?;
        if available.is_empty() {
            if out.is_empty() && !truncated {
                return Ok(None);
            }
            return Ok(Some((String::from_utf8_lossy(&out).to_string(), truncated)));
        }

        let newline_pos = available.iter().position(|byte| *byte == b'\n');
        let take_len = newline_pos.map(|pos| pos + 1).unwrap_or(available.len());
        if out.len() < max_bytes {
            let remaining = max_bytes - out.len();
            out.extend_from_slice(&available[..take_len.min(remaining)]);
            if take_len > remaining {
                truncated = true;
            }
        } else {
            truncated = true;
        }

        reader.consume(take_len);
        if newline_pos.is_some() {
            return Ok(Some((String::from_utf8_lossy(&out).to_string(), truncated)));
        }
    }
}

/// 流式文本合并的定�?flush 间隔 ── 与前�?`streaming-buffer.ts` �?rAF 帧率
/// (~16ms) 对齐。partial 模式�?`claude --include-partial-messages` �?token
/// 一�?stream_event, 后�?做�?称合并后, `agent-chunk` IPC emit 频率�?/// "�?token 一�?降到"每帧一�?�?
pub const STREAM_FLUSH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(16);

/// 合并 buffer 的硬上限 ── burst 期间持续高速文�?���? 超过此值立�?flush,
/// 既防 buffer 无限增长, 也避免单条合�?chunk 过大�?4 KiB 远大于一帧的文本�?
/// 正常�?��不会触达�?
pub const STREAM_FLUSH_MAX_BYTES: usize = 64 * 1024;

/// 帧级文本合并 buffer ── 把高�?`Text` / `Reasoning` chunk 攒批, 减少
/// `emit_chunk_with_run_id` �?IPC 次数�?///
/// 顺序不变�? `Text` / `Reasoning` �?buffer; 其它 chunk (`ToolCall` /
/// `ToolResult` / `Error` / `SessionResolved` / `Usage` / ...) 鐢辫皟鐢ㄦ柟鍏堣皟
/// [`flush`](Self::flush) 拿走缓冲文本 emit, �?emit �?chunk, 保证
/// `text -> tool_call -> text -> tool_result -> text` 鐨勫憟鐜伴『搴忎笌鍚庣鍙戝嚭椤哄簭
/// 一致。`flush` 先产�?`Reasoning` 再产�?`Text`, 与前�?`streaming-buffer` �?/// reasoning-first �?��对齐 (reasoning chunk 先于 text 出现, text 落地�?close
/// reasoning 琛?銆?///
/// �?thread / �?run: 每个 stdout 读取�?��持有�?��实例, 无需并发保护。`flush`
/// 返回 `Vec<AgentChunk>` 而非直接 emit ── �?IPC 交给调用�?(沿用
/// `emit_chunk_with_run_id`), buffer �?��保持�?��辑、可单测�?
pub struct StreamingEmitBuffer {
    thread_id: String,
    text: String,
    reasoning: String,
}

impl StreamingEmitBuffer {
    pub fn new(thread_id: String) -> Self {
        Self {
            thread_id,
            text: String::new(),
            reasoning: String::new(),
        }
    }

    /// 当前缓冲的文�?��节数。调用方�??判断�?��该在阈值�?强制 flush�?
    pub fn pending_bytes(&self) -> usize {
        self.text.len() + self.reasoning.len()
    }

    pub fn is_empty(&self) -> bool {
        self.text.is_empty() && self.reasoning.is_empty()
    }

    pub fn append_text(&mut self, text: &str) {
        self.text.push_str(text);
    }

    pub fn append_reasoning(&mut self, text: &str) {
        self.reasoning.push_str(text);
    }

    /// 取走缓冲文本, �?reasoning �?text, 各自拼成单条 `AgentChunk` 返回�?    /// 空缓冲返回空 vec (调用方无需判空)�?
    pub fn flush(&mut self) -> Vec<AgentChunk> {
        let mut out = Vec::new();
        if !self.reasoning.is_empty() {
            out.push(AgentChunk::Reasoning {
                thread_id: self.thread_id.clone(),
                text: std::mem::take(&mut self.reasoning),
            });
        }
        if !self.text.is_empty() {
            out.push(AgentChunk::Text {
                thread_id: self.thread_id.clone(),
                text: std::mem::take(&mut self.text),
            });
        }
        out
    }
}

pub async fn read_stderr_to_string<R>(
    thread_id: &str,
    expected_run_id: Option<&str>,
    runs: &ExternalRunRegistry,
    reader: R,
) -> Result<String, String>
where
    R: AsyncBufRead + Unpin,
{
    let mut lines = reader.lines();
    let mut out = String::new();
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        runs.touch(thread_id, expected_run_id).await;
        out.push_str(&line);
        out.push('\n');
    }
    Ok(out)
}

/// Truncate `text` to at most `max_chars` Unicode chars, appending a sentinel
/// when truncation occurred. Used for log/preview fields that must stay bounded.
pub fn truncate_chars(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let truncated: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{truncated}\n...[truncated]")
    } else {
        truncated
    }
}

/// Soft cap on text dropped into `runtime_log` / stderr-preview fields. Large
/// enough to diagnose, small enough to keep logs readable. Single source of
/// truth shared by every sidecar CLI.
pub const MAX_LOG_TEXT_CHARS: usize = 2048;

/// [`truncate_chars`] bound by [`MAX_LOG_TEXT_CHARS`] — the standard "preview
/// this for the log" helper shared by every sidecar CLI.
pub fn truncate_for_log(text: &str) -> String {
    truncate_chars(text, MAX_LOG_TEXT_CHARS)
}

/// Read a `BufReader<R>` to a single `String`. The async analogue of reading a
/// child's full stderr when no line-protocol parsing is needed.
pub async fn read_to_string<R>(reader: BufReader<R>) -> Result<String, String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut reader = reader;
    let mut out = String::new();
    reader
        .read_to_string(&mut out)
        .await
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// Derive a default thread title from the user prompt: collapse whitespace,
/// cap at 28 chars, fall back to `"{display_name} session"` when empty. Shared
/// by runtimes that do not get a title back from the CLI.
pub fn default_thread_title(display_name: &str, prompt: &str) -> String {
    let title = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        format!("{display_name} session")
    } else {
        title.chars().take(28).collect()
    }
}

/// Put an external-CLI child in its own process group so `kill_child_tree`
/// can signal the whole group (and its grandchildren) on Unix. No-op on
/// Windows, where `taskkill /T /F` already reaps the tree.
#[cfg(unix)]
pub fn configure_unix_process_group(cmd: &mut tokio::process::Command) {
    // `process_group(0)` => setpgid(0, 0): the child becomes leader of a new
    // group whose pgid == child pid. `kill_child_tree` then `kill(-pgid)` to
    // reap grandchildren (Node CLIs spawn their own shells/tools).
    cmd.as_std_mut().process_group(0);
}

#[cfg(not(unix))]
pub fn configure_unix_process_group(_cmd: &mut tokio::process::Command) {}

/// Kill an external-CLI child process tree. On Windows we use `taskkill /T /F`
/// to take down the whole tree (the child typically spawns its own helpers);
/// on Unix we signal the child's whole process group (set up at spawn via
/// `configure_unix_process_group`) so grandchildren are reaped too. Either
/// way we finish with `Child::kill` to also reap the leader handle.
pub async fn kill_child_tree(child: &mut Child, label: &str, thread_id: &str) {
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        let mut cmd = Command::new("taskkill");
        crate::process_window::hide_command_window(&mut cmd);
        match cmd
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
            .await
        {
            Ok(output) if output.status.success() => return,
            Ok(output) => tracing::warn!(
                "[{label}] taskkill failed for {thread_id}: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
            Err(err) => tracing::warn!("[{label}] failed to run taskkill for {thread_id}: {err}"),
        }
    }

    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // The child was spawned with `process_group(0)`, so it leads a new
        // process group whose pgid == its pid. Signal the whole group to reap
        // grandchildren (Node CLIs spawn their own shells/tools); a bare
        // `child.kill()` would orphan them. SIGTERM for a graceful chance,
        // then SIGKILL. We still fall through to `child.kill()` below to reap
        // the leader handle.
        let pgid = pid as i32;
        unsafe {
            let _ = libc::kill(-pgid, libc::SIGTERM);
            let _ = libc::kill(-pgid, libc::SIGKILL);
        }
    }

    if let Err(err) = child.kill().await {
        tracing::warn!("[{label}] failed to kill child for {thread_id}: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    #[test]
    fn streaming_emit_buffer_batches_text_and_reasoning_in_order() {
        let mut buf = StreamingEmitBuffer::new("t1".to_string());
        assert!(buf.is_empty());
        assert_eq!(buf.pending_bytes(), 0);

        buf.append_text("Hello, ");
        buf.append_text("world!");
        buf.append_reasoning("thinking...");
        // text �?reasoning 各自�?��, 不交叉�?
        assert_eq!(
            buf.pending_bytes(),
            "Hello, world!".len() + "thinking...".len()
        );

        let chunks = buf.flush();
        // reasoning 先于 text (前�? reasoning-first �?��)�?
        assert_eq!(chunks.len(), 2, "expected reasoning + text");
        let reasoning_text = match &chunks[0] {
            AgentChunk::Reasoning { thread_id, text } => {
                assert_eq!(thread_id, "t1");
                text.as_str()
            }
            _ => panic!("expected Reasoning first"),
        };
        assert_eq!(reasoning_text, "thinking...");
        let text_text = match &chunks[1] {
            AgentChunk::Text { thread_id, text } => {
                assert_eq!(thread_id, "t1");
                text.as_str()
            }
            _ => panic!("expected Text second"),
        };
        assert_eq!(text_text, "Hello, world!");
        // flush 后缓冲清�? 再�? flush �?no-op�?
        assert!(buf.is_empty());
        assert!(buf.flush().is_empty());
    }

    #[test]
    fn streaming_emit_buffer_flush_only_emits_non_empty() {
        let mut buf = StreamingEmitBuffer::new("t2".to_string());
        // 只有 text: 仅产出 Text。
        buf.append_text("a");
        let chunks = buf.flush();
        assert_eq!(chunks.len(), 1);
        assert!(matches!(chunks[0], AgentChunk::Text { .. }));
        // 只有 reasoning: 仅产出 Reasoning。
        buf.append_reasoning("b");
        let chunks = buf.flush();
        assert_eq!(chunks.len(), 1);
        assert!(matches!(chunks[0], AgentChunk::Reasoning { .. }));
        // 空: 不产出。
        assert!(buf.flush().is_empty());
    }

    #[test]
    fn registry_metadata_is_thread_scoped() {
        let registry = ExternalRunRegistry::new("codex", "codex");
        assert_eq!(registry.agent_type, "codex");
        assert_eq!(registry.current_tool, "codex");
    }

    #[test]
    fn raw_json_default_follows_build_profile() {
        assert_eq!(default_raw_json_enabled(), cfg!(debug_assertions));
    }

    #[test]
    fn raw_json_env_bool_accepts_only_explicit_true_values() {
        for value in ["1", "true", "TRUE", " yes ", "on"] {
            assert!(parse_env_bool(value), "{value:?} should enable raw_json");
        }

        for value in ["0", "false", "no", "off", "", "maybe"] {
            assert!(!parse_env_bool(value), "{value:?} should disable raw_json");
        }
    }

    /// `stream_end_emitted` �?`stop_chat` / 流式任务 tail / watchdog 三方共享
    /// �?StreamEnd 已发"哨兵 ── 各持一�?Arc clone, 谁先 CAS(false -> true) 谁负�?    /// �? 另两�?CAS 失败�?skip。这条测试钉死�?不变�? 注册时�?进去�?flag
    /// 与调用方手里那份�?��一�?AtomicBool, 且只有一�?CAS 能赢�?
    #[cfg(unix)]
    #[tokio::test]
    async fn stream_end_emitted_flag_is_shared_and_oneshot() {
        use std::sync::atomic::Ordering;

        let registry = ExternalRunRegistry::new("codex", "codex");
        let stream_end_emitted = Arc::new(AtomicBool::new(false));
        let caller_clone = stream_end_emitted.clone();

        let child = tokio::process::Command::new("/usr/bin/true")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn `/usr/bin/true`");
        registry
            .insert(
                "t".to_string(),
                child,
                Some("run-1".to_string()),
                stream_end_emitted,
            )
            .await;

        // stop_chat �?��: �?registry 抢出 entry, �?entry 里的 flag CAS�?
        let running = registry.remove("t").await.expect("running entry exists");
        let stop_won = running
            .stream_end_emitted
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok();

        // 流式任务 tail �?��: 用调用方手里�?clone �?CAS, 必须失败�?
        let tail_won = caller_clone
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok();

        assert!(stop_won, "stop_chat should win the CAS");
        assert!(!tail_won, "streaming tail must skip after stop_chat won");
        assert!(
            caller_clone.load(Ordering::SeqCst),
            "flag must be visible as true to the tail clone"
        );
    }

    #[test]
    fn resolve_run_id_prefers_frontend_run_id() {
        assert_eq!(
            resolve_run_id("thread_1", Some(" frontend-run ")),
            "frontend-run"
        );
    }

    #[test]
    fn resolve_run_id_falls_back_to_generated_thread_scoped_id() {
        let run_id = resolve_run_id("thread_1", Some(" "));
        assert!(run_id.starts_with("thread_1-"));
    }

    #[tokio::test]
    async fn prepare_start_normalizes_run_id_and_creates_unclaimed_terminal_slot() {
        use std::sync::atomic::Ordering;

        let registry = ExternalRunRegistry::new("codex", "codex");
        let start = registry
            .prepare_start("thread_1", Some(" run-1 "))
            .await
            .expect("fresh run should be accepted");

        assert_eq!(start.run_id, "run-1");
        assert!(!start.stream_end_emitted.load(Ordering::SeqCst));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_run_preserves_expected_run_matching_and_shared_terminal_slot() {
        use std::sync::atomic::Ordering;

        let registry = ExternalRunRegistry::new("codex", "codex");
        let stream_end_emitted = Arc::new(AtomicBool::new(false));
        let caller_flag = stream_end_emitted.clone();
        let child = tokio::process::Command::new("/bin/sleep")
            .arg("5")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn `/bin/sleep`");
        registry
            .insert(
                "thread_1".to_string(),
                child,
                Some("run-1".to_string()),
                stream_end_emitted,
            )
            .await;

        assert!(registry
            .stop_run("thread_1", "thread_1", Some("wrong-run"), "TestCli")
            .await
            .is_none());
        assert!(registry.contains("thread_1").await);

        let stopped = registry
            .stop_run("thread_1", "thread_1", Some("run-1"), "TestCli")
            .await
            .expect("matching run should be stopped");
        assert_eq!(stopped.run_id, "run-1");
        assert!(!registry.contains("thread_1").await);
        assert!(Arc::ptr_eq(&caller_flag, &stopped.stream_end_emitted));
        assert!(!caller_flag.load(Ordering::SeqCst));
    }

    #[test]
    fn workspace_context_lists_only_existing_additional_roots() {
        let temp = tempfile::tempdir().unwrap();
        let cwd = temp.path().join("primary");
        let reference = temp.path().join("reference");
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&reference).unwrap();
        let missing = temp.path().join("missing");
        let paths = vec![
            cwd.to_string_lossy().to_string(),
            reference.to_string_lossy().to_string(),
            reference.to_string_lossy().to_string(),
            missing.to_string_lossy().to_string(),
        ];

        let prompt = append_workspace_context("Question", &cwd, &paths);

        assert!(prompt.starts_with("Question\n\n[Flowix workspace context]"));
        assert_eq!(
            prompt
                .matches(&reference.to_string_lossy().to_string())
                .count(),
            1
        );
        assert!(!prompt.contains(&missing.to_string_lossy().to_string()));
    }

    #[tokio::test]
    async fn capped_stdout_reader_truncates_long_lines() {
        let input = format!("{}{}\nnext\n", "x".repeat(20), "y".repeat(20));
        let mut reader = BufReader::new(input.as_bytes());

        let (line, truncated) = read_capped_line(&mut reader, 16)
            .await
            .expect("read line")
            .expect("line");
        assert_eq!(line.len(), 16);
        assert!(truncated);

        let (line, truncated) = read_capped_line(&mut reader, 16)
            .await
            .expect("read next line")
            .expect("next line");
        assert_eq!(line.trim(), "next");
        assert!(!truncated);
    }

    #[tokio::test]
    async fn stderr_reader_preserves_lines_and_newlines() {
        let registry = ExternalRunRegistry::new("codex", "codex");
        let reader = BufReader::new("first\nsecond".as_bytes());

        let stderr = read_stderr_to_string("thread_1", Some("run_1"), &registry, reader)
            .await
            .expect("stderr reader should succeed");

        assert_eq!(stderr, "first\nsecond\n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stderr_reader_touches_matching_run() {
        let registry = ExternalRunRegistry::new("codex", "codex");
        let child = tokio::process::Command::new("/bin/sleep")
            .arg("1")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn `/bin/sleep`");
        registry
            .insert(
                "thread_1".to_string(),
                child,
                Some("run_1".to_string()),
                Arc::new(AtomicBool::new(false)),
            )
            .await;

        {
            let mut children = registry.children.lock().await;
            let running = children
                .get_mut("thread_1")
                .expect("running entry should exist");
            running.last_event_at = 1;
        }

        let reader = BufReader::new("stderr\n".as_bytes());
        read_stderr_to_string("thread_1", Some("run_1"), &registry, reader)
            .await
            .expect("stderr reader should succeed");

        let last_event_at = {
            let children = registry.children.lock().await;
            children
                .get("thread_1")
                .expect("running entry should exist")
                .last_event_at
        };
        assert!(last_event_at > 1);

        let mut running = registry
            .remove("thread_1")
            .await
            .expect("running entry should be removable");
        let _ = running.child.kill().await;
    }

    #[tokio::test]
    async fn reap_stale_returns_none_when_no_entry() {
        let registry = ExternalRunRegistry::new("codex", "codex");
        assert!(registry.reap_stale("missing").await.is_none());
    }

    /// Spawn a child that exits immediately, register it, wait for it to
    /// exit, then call reap_stale 鈥?should drop the entry and return None.
    #[cfg(unix)]
    #[tokio::test]
    async fn reap_stale_drops_already_exited_child() {
        let registry = ExternalRunRegistry::new("codex", "codex");
        let child = tokio::process::Command::new("/usr/bin/true")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn `/usr/bin/true`");
        registry
            .insert(
                "t".to_string(),
                child,
                Some("run-1".to_string()),
                Arc::new(AtomicBool::new(false)),
            )
            .await;
        // Give the kernel a moment to actually reap the process. Without
        // this, try_wait can still return Ok(None) on slow runners.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        assert!(registry.reap_stale("t").await.is_none());
        assert!(!registry.contains("t").await);
    }
}
