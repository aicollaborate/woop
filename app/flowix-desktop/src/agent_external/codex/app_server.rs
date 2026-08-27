//! Long-lived Codex app-server runtime.
//!
//! The app-server protocol is JSON-RPC over JSONL on stdio. A single server
//! owns many Codex threads and turns, so Flowix keeps the process connection
//! separately from the per-thread run registry.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex};

use super::command::{build_codex_entrypoint, preflight_codex, resolve_codex_cwd};
use super::AGENT_TYPE;
use crate::agent_external::lifecycle::ExternalLifecycleEmitter;
use crate::agent_external::{
    emit_chunk_with_run_id, emit_chunk_with_run_id_and_metadata,
    select_external_session_for_runtime, AgentChunkMetadata, USER_STOPPED_REASON,
};
use crate::agent_session::{ChatMessage, ThreadInfo, ThreadManager, ThreadMessagesPage};
use crate::agent_types::AgentId;
use crate::agent_wire::{AgentChunk, AgentUserMessage, RunInfo};

const INITIALIZE_METHOD: &str = "initialize";
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

struct Connection {
    _child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
}

struct ActiveTurn {
    flowix_thread_id: String,
    run_id: String,
    codex_thread_id: String,
    codex_turn_id: String,
    app_handle: tauri::AppHandle,
    started_at: i64,
    last_event_at: i64,
    stream_end_emitted: Arc<AtomicBool>,
}

struct Inner {
    thread_manager: Arc<ThreadManager>,
    connection: Mutex<Option<Connection>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    active_turns: Mutex<HashMap<String, ActiveTurn>>,
    next_request_id: AtomicU64,
}

pub struct CodexAppServerManager {
    inner: Arc<Inner>,
}

impl CodexAppServerManager {
    pub fn new(thread_manager: Arc<ThreadManager>) -> Self {
        Self {
            inner: Arc::new(Inner {
                thread_manager,
                connection: Mutex::new(None),
                pending: Mutex::new(HashMap::new()),
                active_turns: Mutex::new(HashMap::new()),
                next_request_id: AtomicU64::new(1),
            }),
        }
    }

    async fn ensure_connection(&self) -> Result<(), String> {
        if self.inner.connection.lock().await.is_some() {
            return Ok(());
        }

        preflight_codex()?;
        let mut command = build_codex_entrypoint();
        command
            .args(["app-server", "--listen", "stdio://"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::process_window::hide_command_window(&mut command);
        crate::agent_external::shared::configure_unix_process_group(&mut command);
        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to start Codex app-server: {error}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Codex app-server stdin is unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Codex app-server stdout is unavailable".to_string())?;
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if !line.trim().is_empty() {
                        tracing::debug!("[CodexAppServer] stderr: {line}");
                    }
                }
            });
        }

        let stdin = Arc::new(Mutex::new(stdin));
        let reader_inner = self.inner.clone();
        let reader_stdin = stdin.clone();
        tokio::spawn(async move {
            read_loop(reader_inner, reader_stdin, BufReader::new(stdout)).await;
        });
        *self.inner.connection.lock().await = Some(Connection {
            _child: child,
            stdin,
        });

        self.request(
            INITIALIZE_METHOD,
            json!({
                "clientInfo": {
                    "name": "flowix",
                    "title": "Flowix",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "capabilities": { "experimentalApi": true }
            }),
        )
        .await?;
        self.notify("initialized", json!({})).await
    }

    async fn write(&self, message: Value) -> Result<(), String> {
        let stdin = self
            .inner
            .connection
            .lock()
            .await
            .as_ref()
            .map(|connection| connection.stdin.clone())
            .ok_or_else(|| "Codex app-server is not connected".to_string())?;
        let mut stdin = stdin.lock().await;
        let encoded = serde_json::to_string(&message).map_err(|error| error.to_string())?;
        stdin
            .write_all(encoded.as_bytes())
            .await
            .map_err(|error| format!("failed to write to Codex app-server: {error}"))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|error| format!("failed to delimit Codex app-server message: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("failed to flush Codex app-server input: {error}"))
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.inner.next_request_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.inner.pending.lock().await.insert(id, sender);
        if let Err(error) = self
            .write(json!({ "id": id, "method": method, "params": params }))
            .await
        {
            self.inner.pending.lock().await.remove(&id);
            return Err(error);
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(format!(
                "Codex app-server closed before responding to {method}"
            )),
            Err(_) => {
                self.inner.pending.lock().await.remove(&id);
                Err(format!("Codex app-server timed out responding to {method}"))
            }
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.write(json!({ "method": method, "params": params }))
            .await
    }

    async fn resolve_codex_thread(
        &self,
        flowix_thread_id: &str,
        message: &AgentUserMessage,
    ) -> Result<(String, PathBuf), String> {
        let stored = self
            .inner
            .thread_manager
            .get_external_session(flowix_thread_id, AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?;
        let session_id = select_external_session_for_runtime(stored, None);
        let cwd = self
            .resolve_codex_cwd_for_next_turn(flowix_thread_id, message)
            .await?;
        if let Some(codex_thread_id) = session_id {
            self.request("thread/resume", json!({ "threadId": codex_thread_id }))
                .await?;
            return Ok((codex_thread_id, cwd));
        }

        let sandbox = app_server_sandbox(message.permission_mode_for_runtime(AGENT_TYPE));
        // Flowix does not yet expose an approval callback. Unexpected server
        // requests are still declined below rather than granting access.
        let approval = "never";
        let workspace_roots = message.workspace_paths_for_runtime(AGENT_TYPE);
        let result = self
            .request(
                "thread/start",
                json!({
                    "cwd": cwd,
                    "model": message.codex_model_for_runtime(),
                    "sandbox": sandbox,
                    "approvalPolicy": approval,
                    "runtimeWorkspaceRoots": workspace_roots,
                    "serviceName": "flowix"
                }),
            )
            .await?;
        let codex_thread_id = result
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| "Codex app-server did not return a thread id".to_string())?
            .to_string();
        self.inner
            .thread_manager
            .upsert_external_session(flowix_thread_id, AGENT_TYPE, &codex_thread_id, Some(result))
            .await
            .map_err(|error| error.to_string())?;
        Ok((codex_thread_id, cwd))
    }

    /// `turn/start` accepts `cwd`, so Codex can deliberately apply a workspace
    /// selection made while a previous turn was running. Keep Flowix's stored
    /// cwd in sync for session metadata, but do not let that historical value
    /// override the directory selected for this next turn.
    async fn resolve_codex_cwd_for_next_turn(
        &self,
        flowix_thread_id: &str,
        message: &AgentUserMessage,
    ) -> Result<PathBuf, String> {
        let cwd = resolve_codex_cwd(message, None).ok_or_else(|| {
            "Agent working directory unavailable; open a notebook or pick a folder".to_string()
        })?;
        if self
            .inner
            .thread_manager
            .read_frozen_cwd(flowix_thread_id)
            .await
            .ok()
            .flatten()
            .as_ref()
            != Some(&cwd)
        {
            if let Err(error) = self
                .inner
                .thread_manager
                .upsert_frozen_cwd(flowix_thread_id, &cwd)
                .await
            {
                tracing::warn!(
                    "failed to persist Codex working directory for {flowix_thread_id}: {error}"
                );
            }
        }
        Ok(cwd)
    }

    pub async fn chat_stream(
        self: &Arc<Self>,
        flowix_thread_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<String, String> {
        self.ensure_connection().await?;
        let flowix_thread_id = flowix_thread_id.to_string();
        let run_id = message
            .run_id
            .clone()
            .unwrap_or_else(|| crate::agent_external::resolve_run_id(&flowix_thread_id, None));
        if self
            .inner
            .active_turns
            .lock()
            .await
            .contains_key(&flowix_thread_id)
        {
            return Err("Codex already has an active turn for this thread".to_string());
        }
        self.emit_user_message(app_handle, &flowix_thread_id, &message, &run_id)
            .await;
        self.emit_stream_start(app_handle, &flowix_thread_id, &message, &run_id)
            .await;

        let started = async {
            let (codex_thread_id, cwd) = self.resolve_codex_thread(&flowix_thread_id, &message).await?;
            let mut input = vec![json!({ "type": "text", "text": message.llm_content.clone().unwrap_or_else(|| message.content.clone()) })];
            input.extend(message.image_paths.iter().filter(|path| std::path::Path::new(path).is_file()).map(|path| json!({ "type": "localImage", "path": path })));
            let result = self.request("turn/start", json!({
                "threadId": codex_thread_id,
                "input": input,
                "cwd": cwd,
                "model": message.codex_model_for_runtime(),
                "effort": message.codex_reasoning_effort_for_runtime()
            })).await?;
            let codex_turn_id = result.pointer("/turn/id").and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| "Codex app-server did not return a turn id".to_string())?.to_string();
            self.inner.active_turns.lock().await.insert(flowix_thread_id.clone(), ActiveTurn {
                flowix_thread_id: flowix_thread_id.clone(), run_id: run_id.clone(), codex_thread_id,
                codex_turn_id, app_handle: app_handle.clone(), started_at: chrono::Utc::now().timestamp_millis(),
                last_event_at: chrono::Utc::now().timestamp_millis(), stream_end_emitted: Arc::new(AtomicBool::new(false)),
            });
            Ok::<(), String>(())
        }.await;
        if let Err(error) = started {
            self.emit_run_error(app_handle, &flowix_thread_id, error.clone(), &run_id)
                .await;
            self.emit_stream_end(
                app_handle,
                &flowix_thread_id,
                &run_id,
                Some(error),
                &Arc::new(AtomicBool::new(false)),
            )
            .await;
        }
        Ok(String::new())
    }

    pub async fn stop_chat(
        &self,
        thread_id: &str,
        _run_id: Option<&str>,
        app_handle: &tauri::AppHandle,
    ) -> bool {
        let active = self.inner.active_turns.lock().await.remove(thread_id);
        let Some(active) = active else {
            return false;
        };
        let _ = self
            .request(
                "turn/interrupt",
                json!({ "threadId": active.codex_thread_id, "turnId": active.codex_turn_id }),
            )
            .await;
        self.emit_stream_end(
            app_handle,
            &active.flowix_thread_id,
            &active.run_id,
            Some(USER_STOPPED_REASON.to_string()),
            &active.stream_end_emitted,
        )
        .await;
        true
    }

    pub async fn running_threads(&self) -> HashMap<String, RunInfo> {
        self.inner
            .active_turns
            .lock()
            .await
            .iter()
            .map(|(id, active)| {
                (
                    id.clone(),
                    RunInfo::active(
                        active.started_at,
                        None,
                        Some(AGENT_TYPE),
                        Some(active.run_id.clone()),
                        Some(active.flowix_thread_id.clone()),
                        Some(active.codex_thread_id.clone()),
                    ),
                )
            })
            .collect()
    }

    pub async fn stop_all(&self) -> usize {
        let active = std::mem::take(&mut *self.inner.active_turns.lock().await);
        let count = active.len();
        for (_, turn) in active {
            let _ = self
                .request(
                    "turn/interrupt",
                    json!({ "threadId": turn.codex_thread_id, "turnId": turn.codex_turn_id }),
                )
                .await;
            self.emit_stream_end(
                &turn.app_handle,
                &turn.flowix_thread_id,
                &turn.run_id,
                Some(USER_STOPPED_REASON.to_string()),
                &turn.stream_end_emitted,
            )
            .await;
        }
        count
    }

    pub async fn reap_inactive_runs(
        &self,
        app_handle: &tauri::AppHandle,
        idle_timeout_ms: i64,
    ) -> usize {
        let now = chrono::Utc::now().timestamp_millis();
        let stale = self
            .inner
            .active_turns
            .lock()
            .await
            .iter()
            .filter_map(|(id, active)| {
                ((now - active.last_event_at) > idle_timeout_ms).then_some(id.clone())
            })
            .collect::<Vec<_>>();
        let mut count = 0;
        for id in stale {
            if self.stop_chat(&id, None, app_handle).await {
                count += 1;
            }
        }
        count
    }

    pub async fn supported_models(&self) -> Result<Vec<String>, String> {
        self.ensure_connection().await?;
        let result = self.request("model/list", json!({ "limit": 100 })).await?;
        let mut seen = std::collections::HashSet::new();
        Ok(result
            .get("data")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|model| {
                model
                    .get("model")
                    .or_else(|| model.get("id"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|model| !model.is_empty())
            })
            .filter(|model| seen.insert((*model).to_string()))
            .map(str::to_string)
            .collect())
    }

    pub async fn list_threads(&self) -> Result<Vec<ThreadInfo>, String> {
        self.ensure_connection().await?;
        let mut cursor = None;
        let mut threads = Vec::new();
        loop {
            let result = self
                .request(
                    "thread/list",
                    json!({
                        "cursor": cursor,
                        "limit": 100,
                        "sortKey": "recency_at",
                        "sourceKinds": ["cli", "vscode", "appServer"]
                    }),
                )
                .await?;
            threads.extend(
                result
                    .get("data")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(app_server_thread_info),
            );
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_string);
            if cursor.is_none() {
                return Ok(threads);
            }
        }
    }

    pub async fn get_thread_messages(&self, thread_id: &str) -> Result<Vec<ChatMessage>, String> {
        let mut page = self.get_thread_messages_page(thread_id, None, 1000).await?;
        let mut messages = page.messages;
        while page.has_more {
            page = self
                .get_thread_messages_page(thread_id, page.oldest_sequence, 1000)
                .await?;
            let mut older = page.messages;
            older.append(&mut messages);
            messages = older;
        }
        Ok(messages)
    }

    pub async fn get_thread_messages_page(
        &self,
        thread_id: &str,
        before_sequence: Option<i64>,
        limit: i64,
    ) -> Result<ThreadMessagesPage, String> {
        self.ensure_connection().await?;
        // Codex owns the transcript. Use the paged turns API and explicitly
        // request full items; the default `summary` view omits tool items (or
        // leaves the turn's items empty), which makes live tool rows disappear
        // as soon as the frontend reconciles after stream_end.
        let mut cursor: Option<String> = None;
        let mut turns = Vec::new();
        loop {
            let result = self
                .request(
                    "thread/turns/list",
                    json!({
                        "threadId": thread_id,
                        "cursor": cursor,
                        "limit": 100,
                        "sortDirection": "asc",
                        "itemsView": "full"
                    }),
                )
                .await?;
            turns.extend(
                result
                    .get("data")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .cloned(),
            );
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        let turn_ids = turns
            .iter()
            .filter_map(|turn| turn.get("id").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>();
        let mut custom_tools = Vec::new();
        // Some Codex rollouts contain Responses API custom tool records that
        // the App Server history projection does not expose as ThreadItems.
        // Ask the server for its authoritative rollout path instead of
        // guessing/scanning ~/.codex, then use the JSONL only for those
        // missing custom tool rows.
        if let Ok(thread) = self
            .request(
                "thread/read",
                json!({ "threadId": thread_id, "includeTurns": false }),
            )
            .await
        {
            if let Some(path) = thread
                .pointer("/thread/path")
                .and_then(Value::as_str)
                .filter(|path| !path.trim().is_empty())
            {
                match read_rollout_custom_tool_messages(path, &turn_ids).await {
                    Ok(parsed) => custom_tools = parsed,
                    Err(error) => tracing::debug!(
                        "failed to read Codex rollout custom tools from {path}: {error}"
                    ),
                }
            }
        }
        let all = app_server_turn_messages_with_custom_tools(&turns, custom_tools);
        Ok(paginate_app_server_messages(all, before_sequence, limit))
    }
}

struct RolloutCustomToolMessage {
    turn_index: Option<usize>,
    assistant_before: usize,
    line_index: usize,
    message: ChatMessage,
}

fn app_server_turn_messages_with_custom_tools(
    turns: &[Value],
    custom_tools: Vec<RolloutCustomToolMessage>,
) -> Vec<ChatMessage> {
    let mut by_turn = HashMap::<usize, Vec<RolloutCustomToolMessage>>::new();
    let mut unmatched = Vec::new();
    for tool in custom_tools {
        if let Some(turn_index) = tool.turn_index {
            by_turn.entry(turn_index).or_default().push(tool);
        } else {
            unmatched.push(tool);
        }
    }

    let mut messages = Vec::new();
    for (turn_index, turn) in turns.iter().enumerate() {
        // App-server messages are timestamped with the turn start time by
        // `app_server_turn_messages`, while rollout custom-tool records carry
        // their actual execution time.  The web store uses timestamps as a
        // fallback ordering key when it merges a live snapshot with history.
        // Keep the turn's canonical timestamp here so that the explicit
        // JSONL/item order below remains authoritative within a turn.
        let turn_timestamp = app_server_timestamp_string(
            turn.get("startedAt")
                .or_else(|| turn.get("createdAt"))
                .and_then(Value::as_i64),
        );
        let mut turn_messages = app_server_turn_messages(std::slice::from_ref(turn));
        let mut tools = by_turn.remove(&turn_index).unwrap_or_default();
        tools.sort_by_key(|tool| tool.line_index);
        let assistant_positions = turn_messages
            .iter()
            .enumerate()
            .filter_map(|(index, message)| (message.role == "assistant").then_some(index))
            .collect::<Vec<_>>();
        let mut inserted = 0;
        for tool in tools {
            let mut tool = tool;
            tool.message.timestamp = turn_timestamp.clone();
            let base_index = assistant_positions
                .get(tool.assistant_before)
                .copied()
                .unwrap_or(turn_messages.len());
            let insert_at = (base_index + inserted).min(turn_messages.len());
            turn_messages.insert(insert_at, tool.message);
            inserted += 1;
        }
        messages.extend(turn_messages);
    }
    unmatched.sort_by_key(|tool| tool.line_index);
    messages.extend(unmatched.into_iter().map(|tool| tool.message));
    messages
}

async fn read_rollout_custom_tool_messages(
    path: &str,
    turn_ids: &[String],
) -> Result<Vec<RolloutCustomToolMessage>, String> {
    let contents = tokio::fs::read_to_string(path)
        .await
        .map_err(|error| error.to_string())?;
    let mut messages = Vec::new();
    let mut indexes = HashMap::<String, Vec<usize>>::new();
    let turn_indexes = turn_ids
        .iter()
        .enumerate()
        .map(|(index, id)| (id.as_str(), index))
        .collect::<HashMap<_, _>>();
    let mut current_turn_index = None;
    let mut assistant_before = 0usize;

    for (line_index, line) in contents.lines().enumerate() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let record_type = record.get("type").and_then(Value::as_str);
        if record_type == Some("event_msg") {
            if record.pointer("/payload/type").and_then(Value::as_str) == Some("task_started") {
                current_turn_index = record
                    .pointer("/payload/turn_id")
                    .and_then(Value::as_str)
                    .and_then(|id| turn_indexes.get(id).copied());
                assistant_before = 0;
            }
            // MCP calls are not ThreadItems in several Codex App Server
            // versions. They are recorded as rollout event messages, so a
            // history reload previously lost rows that were visible during the
            // live stream as soon as completion reconciliation ran.
            if record.pointer("/payload/type").and_then(Value::as_str) == Some("mcp_tool_call_end")
            {
                if let Some(message) = rollout_mcp_tool_message(
                    record.get("payload").unwrap_or(&Value::Null),
                    record
                        .get("timestamp")
                        .and_then(Value::as_str)
                        .unwrap_or("1970-01-01T00:00:00Z"),
                ) {
                    messages.push(RolloutCustomToolMessage {
                        turn_index: current_turn_index,
                        assistant_before,
                        line_index,
                        message,
                    });
                }
            }
            continue;
        }
        if record_type != Some("response_item") {
            continue;
        }
        let Some(payload) = record.get("payload") else {
            continue;
        };
        let Some(kind) = payload.get("type").and_then(Value::as_str) else {
            continue;
        };
        if kind == "message" && payload.get("role").and_then(Value::as_str) == Some("assistant") {
            assistant_before += 1;
            continue;
        }
        let Some(call_id) = payload
            .get("call_id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
        else {
            continue;
        };
        if !matches!(kind, "custom_tool_call" | "custom_tool_call_output") {
            continue;
        }

        let timestamp = record
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or("1970-01-01T00:00:00Z");
        let message_id = format!("codex-custom-tool-{call_id}");

        if kind == "custom_tool_call" {
            let presentations = custom_tool_history_presentations(payload);
            let multi_command = presentations.len() > 1;
            let message_indexes = presentations
                .into_iter()
                .enumerate()
                .map(|(index, (tool_name, tool_input))| {
                    let suffix = multi_command.then(|| format!("-{index}"));
                    let mut message = app_server_base_message(
                        format!("{message_id}{}", suffix.as_deref().unwrap_or("")),
                        timestamp,
                    );
                    message.role = "tool".to_string();
                    message.tool_call_id = Some(match suffix {
                        Some(suffix) => format!("{call_id}{suffix}"),
                        None => call_id.to_string(),
                    });
                    message.tool_name = tool_name;
                    message.tool_input = tool_input;
                    message.tool_data = serde_json::to_string(payload).ok();
                    message.is_completed = payload
                        .get("status")
                        .and_then(Value::as_str)
                        .map(|status| status != "in_progress");
                    let message_index = messages.len();
                    messages.push(RolloutCustomToolMessage {
                        turn_index: current_turn_index,
                        assistant_before,
                        line_index: line_index + index,
                        message,
                    });
                    message_index
                })
                .collect();
            indexes.insert(call_id.to_string(), message_indexes);
        } else {
            let output = payload.get("output").cloned().unwrap_or(Value::Null);
            let output_text = app_server_custom_tool_output(&output);
            if let Some(message_indexes) = indexes.get(call_id) {
                // A custom `exec` wrapper can invoke several command actions
                // (typically through Promise.all). The rollout keeps only one
                // aggregate wrapper output, so use it once while marking every
                // reconstructed command complete.
                for (position, index) in message_indexes.iter().enumerate() {
                    let message = &mut messages[*index].message;
                    if position + 1 == message_indexes.len() {
                        message.content = output_text.clone();
                        message.tool_data = Some(output_text.clone());
                    }
                    message.is_completed = Some(true);
                }
            } else {
                let mut message = app_server_base_message(message_id, timestamp);
                message.role = "tool".to_string();
                message.content = output_text.clone();
                message.tool_data = Some(output_text);
                message.tool_call_id = Some(call_id.to_string());
                message.tool_name = Some("unknown_tool".to_string());
                message.is_completed = Some(true);
                indexes.insert(call_id.to_string(), vec![messages.len()]);
                messages.push(RolloutCustomToolMessage {
                    turn_index: current_turn_index,
                    assistant_before,
                    line_index,
                    message,
                });
            }
        }
    }
    Ok(messages)
}

fn rollout_mcp_tool_message(payload: &Value, timestamp: &str) -> Option<ChatMessage> {
    let call_id = payload
        .get("call_id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())?;
    let invocation = payload.get("invocation")?;
    let tool = invocation
        .get("tool")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())?;

    let result = payload.get("result").cloned().unwrap_or(Value::Null);
    let mut message = app_server_base_message(format!("codex-mcp-tool-{call_id}"), timestamp);
    message.role = "tool".to_string();
    message.content = app_server_custom_tool_output(&result);
    message.tool_call_id = Some(call_id.to_string());
    message.tool_name = Some("mcp_tool_call".to_string());
    message.tool_input = Some(invocation.clone());
    message.tool_data = serde_json::to_string(&result).ok();
    message.is_completed = Some(true);

    // Keep the provider's concrete tool name in the input payload; the web
    // formatter uses it together with `server` for the compact MCP label.
    debug_assert!(!tool.is_empty());
    Some(message)
}

fn parse_custom_tool_input(value: &Value) -> Value {
    value
        .as_str()
        .and_then(|text| serde_json::from_str(text).ok())
        .unwrap_or_else(|| value.clone())
}

/// Codex records the host `exec` capability as a custom tool whose input is
/// JavaScript source (`tools.exec_command({ cmd: ... })`). During the live run
/// App Server exposes the nested action as `commandExecution`, so projecting
/// the wrapper verbatim made the same tool render differently after history
/// reconciliation. Recover the concrete command for the historical view.
fn custom_tool_history_presentations(payload: &Value) -> Vec<(Option<String>, Option<Value>)> {
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string);
    let input = payload.get("input");

    if name.as_deref() == Some("exec") {
        let commands = input
            .and_then(Value::as_str)
            .map(extract_exec_commands)
            .unwrap_or_default();
        if !commands.is_empty() {
            return commands
                .into_iter()
                .map(|command| {
                    (
                        Some("command_execution".to_string()),
                        Some(serde_json::json!({ "command": command })),
                    )
                })
                .collect();
        }
    }

    vec![(name, input.map(parse_custom_tool_input))]
}

fn extract_exec_commands(source: &str) -> Vec<String> {
    let mut commands = Vec::new();
    let mut remaining = source;
    while let Some(start) = remaining.find("tools.exec_command") {
        let call = &remaining[start..];
        if let Some(command) = extract_first_exec_command(call) {
            commands.push(command);
        }
        remaining = &call["tools.exec_command".len()..];
    }
    commands
}

fn extract_first_exec_command(source: &str) -> Option<String> {
    let start = source.find("tools.exec_command")?;
    // Search within the call arguments. Looking from the function name itself
    // accidentally found the `cmd` characters inside `exec_command`.
    let source = &source[start + "tools.exec_command".len()..];
    let opening_paren = source.find('(')?;
    let source = &source[opening_paren + 1..];
    let rest = source.match_indices("cmd").find_map(|(index, _)| {
        let before = &source[..index];
        let after = &source[index + "cmd".len()..];
        let before = before.trim_end();

        // The property may be written as `cmd: ...`, `"cmd": ...`, or
        // `'cmd': ...`; accept it only at an object-property boundary.
        let value_after_key = match before.chars().last() {
            Some('{' | ',') => Some(after),
            Some(quote @ ('\'' | '"')) if after.starts_with(quote) => {
                let before_quote = &before[..before.len() - quote.len_utf8()];
                matches!(before_quote.trim_end().chars().last(), Some('{' | ','))
                    .then_some(&after[quote.len_utf8()..])
            }
            _ => None,
        }?;

        value_after_key.trim_start().strip_prefix(':')
    })?;
    let mut chars = rest.chars().peekable();
    while matches!(chars.peek(), Some(ch) if ch.is_whitespace()) {
        chars.next();
    }
    let quote = match chars.next()? {
        quote @ ('\'' | '"') => quote,
        _ => return None,
    };
    let mut escaped = false;
    let mut value = String::new();
    for ch in chars {
        if escaped {
            value.push(match ch {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                other => other,
            });
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == quote {
            return Some(value);
        } else {
            value.push(ch);
        }
    }
    None
}

fn app_server_custom_tool_output(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

#[async_trait::async_trait]
impl ExternalLifecycleEmitter for CodexAppServerManager {
    fn lifecycle_agent_type(&self) -> &'static str {
        AGENT_TYPE
    }
    async fn emit_and_persist_lifecycle_chunk(
        &self,
        app: &tauri::AppHandle,
        chunk: &AgentChunk,
        run_id: &str,
    ) {
        emit_chunk_with_run_id(app, chunk, AGENT_TYPE, run_id);
    }
}

async fn read_loop(
    inner: Arc<Inner>,
    stdin: Arc<Mutex<ChildStdin>>,
    mut reader: BufReader<tokio::process::ChildStdout>,
) {
    let mut line = String::new();
    loop {
        line.clear();
        let Ok(bytes) = reader.read_line(&mut line).await else {
            break;
        };
        if bytes == 0 {
            break;
        }
        let Ok(message) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if let Some(id) = message.get("id").and_then(Value::as_u64) {
            if let Some(sender) = inner.pending.lock().await.remove(&id) {
                let result = message
                    .get("error")
                    .map(|error| {
                        Err(error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("Codex app-server request failed")
                            .to_string())
                    })
                    .unwrap_or_else(|| Ok(message.get("result").cloned().unwrap_or(Value::Null)));
                let _ = sender.send(result);
                continue;
            }
            // Server-initiated approval request. Flowix has no approval UI yet;
            // decline safely instead of accidentally granting write access.
            let reply = json!({ "id": id, "result": "decline" });
            if let Ok(encoded) = serde_json::to_string(&reply) {
                let mut writer = stdin.lock().await;
                let _ = writer.write_all(format!("{encoded}\n").as_bytes()).await;
                let _ = writer.flush().await;
            }
            continue;
        }
        dispatch_notification(&inner, &message).await;
    }
    for (_, sender) in inner.pending.lock().await.drain() {
        let _ = sender.send(Err("Codex app-server connection closed".to_string()));
    }
}

async fn dispatch_notification(inner: &Arc<Inner>, message: &Value) {
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return;
    };
    let params = message.get("params").unwrap_or(&Value::Null);
    let thread_id = params
        .get("threadId")
        .and_then(Value::as_str)
        .or_else(|| params.pointer("/turn/threadId").and_then(Value::as_str));
    let turn_id = params
        .get("turnId")
        .and_then(Value::as_str)
        .or_else(|| params.pointer("/turn/id").and_then(Value::as_str));
    let active = {
        let mut turns = inner.active_turns.lock().await;
        // Item lifecycle notifications are turn-scoped. Never fall back to
        // the currently active turn when `turnId` is absent: a late item from
        // the previous turn would otherwise be attributed to the new run on
        // the same Codex thread.
        let requires_exact_turn = turn_scoped_notification(method);
        let found = (thread_id.is_some() || turn_id.is_some())
            && (!requires_exact_turn || (thread_id.is_some() && turn_id.is_some()));
        let found = found
            .then(|| {
                turns.values_mut().find(|active| {
                    thread_id
                        .map(|id| id == active.codex_thread_id)
                        .unwrap_or(true)
                        && turn_id.map(|id| id == active.codex_turn_id).unwrap_or(true)
                })
            })
            .flatten();
        found.map(|active| {
            active.last_event_at = chrono::Utc::now().timestamp_millis();
            (
                active.flowix_thread_id.clone(),
                active.run_id.clone(),
                active.app_handle.clone(),
                active.stream_end_emitted.clone(),
            )
        })
    };
    let Some((flowix_thread_id, run_id, app, ended)) = active else {
        return;
    };
    match method {
        "item/agentMessage/delta" => {
            if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                emit_notification_chunk_with_metadata(
                    inner,
                    &flowix_thread_id,
                    &run_id,
                    &app,
                    AgentChunk::Text {
                        thread_id: flowix_thread_id.clone(),
                        text: delta.to_string(),
                    },
                    item_delta_metadata(params),
                )
                .await;
            }
        }
        "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
            if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                emit_notification_chunk_with_metadata(
                    inner,
                    &flowix_thread_id,
                    &run_id,
                    &app,
                    AgentChunk::Reasoning {
                        thread_id: flowix_thread_id.clone(),
                        text: delta.to_string(),
                    },
                    item_delta_metadata(params),
                )
                .await;
            }
        }
        "item/started" => {
            if let Some(item) = params.get("item") {
                if let Some((id, name)) = tool_identity(item) {
                    emit_notification_chunk_with_metadata(
                        inner,
                        &flowix_thread_id,
                        &run_id,
                        &app,
                        AgentChunk::ToolCall {
                            thread_id: flowix_thread_id.clone(),
                            id,
                            name,
                            input: item.clone(),
                        },
                        item_metadata(item),
                    )
                    .await;
                }
            }
        }
        "item/completed" => {
            if let Some(item) = params.get("item") {
                if let Some((id, name)) = tool_identity(item) {
                    emit_notification_chunk_with_metadata(
                        inner,
                        &flowix_thread_id,
                        &run_id,
                        &app,
                        AgentChunk::ToolResult {
                            thread_id: flowix_thread_id.clone(),
                            id,
                            name,
                            result: item.clone(),
                        },
                        item_metadata(item),
                    )
                    .await;
                }
            }
        }
        "turn/completed" => {
            let status = params
                .pointer("/turn/status")
                .and_then(Value::as_str)
                .unwrap_or("failed");
            let reason = match status {
                "completed" => None,
                "interrupted" => Some(USER_STOPPED_REASON.to_string()),
                _ => Some(
                    params
                        .pointer("/turn/error/message")
                        .and_then(Value::as_str)
                        .unwrap_or("Codex turn failed")
                        .to_string(),
                ),
            };
            if ended
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
            {
                if let Some(reason) = &reason {
                    emit_notification_chunk(
                        inner,
                        &flowix_thread_id,
                        &run_id,
                        &app,
                        AgentChunk::Error {
                            thread_id: flowix_thread_id.clone(),
                            message: reason.clone(),
                            error_details: Some(crate::agent_external::classify_agent_error(
                                reason,
                                "app-server",
                            )),
                        },
                    )
                    .await;
                }
                emit_notification_chunk(
                    inner,
                    &flowix_thread_id,
                    &run_id,
                    &app,
                    AgentChunk::StreamEnd {
                        thread_id: flowix_thread_id.clone(),
                        reason,
                    },
                )
                .await;
            }
            inner.active_turns.lock().await.remove(&flowix_thread_id);
        }
        _ => {}
    }
}

fn turn_scoped_notification(method: &str) -> bool {
    matches!(
        method,
        "item/agentMessage/delta"
            | "item/reasoning/summaryTextDelta"
            | "item/reasoning/textDelta"
            | "item/started"
            | "item/completed"
            | "turn/completed"
    )
}

async fn emit_notification_chunk(
    _inner: &Arc<Inner>,
    _flowix_thread_id: &str,
    run_id: &str,
    app: &tauri::AppHandle,
    chunk: AgentChunk,
) {
    emit_chunk_with_run_id(app, &chunk, AGENT_TYPE, run_id);
}

async fn emit_notification_chunk_with_metadata(
    _inner: &Arc<Inner>,
    _flowix_thread_id: &str,
    run_id: &str,
    app: &tauri::AppHandle,
    chunk: AgentChunk,
    metadata: AgentChunkMetadata,
) {
    emit_chunk_with_run_id_and_metadata(app, &chunk, AGENT_TYPE, run_id, &metadata);
}

fn item_delta_metadata(params: &Value) -> AgentChunkMetadata {
    let item_id = params
        .get("itemId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string);
    item_metadata_from_id(item_id)
}

fn item_metadata(item: &Value) -> AgentChunkMetadata {
    let item_id = item
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string);
    item_metadata_from_id(item_id)
}

fn item_metadata_from_id(item_id: Option<String>) -> AgentChunkMetadata {
    AgentChunkMetadata {
        message_id: item_id.clone(),
        source_message_id: item_id,
        ..AgentChunkMetadata::default()
    }
}

fn tool_identity(item: &Value) -> Option<(String, String)> {
    let kind = item.get("type").and_then(Value::as_str)?;
    let name = match kind {
        "commandExecution" => "command_execution",
        "fileChange" => "file_change",
        "mcpToolCall" => "mcp_tool_call",
        "dynamicToolCall" => "dynamic_tool_call",
        // `collabToolCall` is the current App Server item name. Keep the
        // legacy spelling as an input alias for older Codex versions.
        "collabToolCall" | "collabAgentToolCall" => "collab_agent_tool_call",
        "webSearch" => "web_search",
        "imageView" | "imageGeneration" => "image_generation",
        _ => return None,
    };
    let id = item.get("id").and_then(Value::as_str)?.to_string();
    Some((id, name.to_string()))
}

/// The currently installed app-server serializes this legacy `sandbox` field
/// with kebab-case variants. Keep the wire spelling here, separate from the
/// App Server v2 `permissions` profile API.
fn app_server_sandbox(permission: Option<&str>) -> &'static str {
    match permission.map(str::trim) {
        Some("read-only") => "read-only",
        Some("danger-full-access" | "yolo") => "danger-full-access",
        _ => "workspace-write",
    }
}

fn app_server_thread_info(thread: &Value) -> Option<ThreadInfo> {
    let thread_id = thread.get("id")?.as_str()?.trim();
    if thread_id.is_empty() {
        return None;
    }
    let created_at = app_server_timestamp_millis(thread.get("createdAt").and_then(Value::as_i64));
    let updated_at = app_server_timestamp_millis(
        thread
            .get("updatedAt")
            .or_else(|| thread.get("recencyAt"))
            .and_then(Value::as_i64),
    )
    .max(created_at);
    Some(ThreadInfo {
        thread_id: thread_id.to_string(),
        agent_id: AgentId::new(AGENT_TYPE),
        title: thread
            .get("name")
            .or_else(|| thread.get("preview"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .unwrap_or("Codex Session")
            .to_string(),
        created_at,
        updated_at,
    })
}

fn app_server_turn_messages(turns: &[Value]) -> Vec<ChatMessage> {
    let mut messages = Vec::new();
    for (turn_index, turn) in turns.iter().enumerate() {
        let timestamp = app_server_timestamp_string(
            turn.get("startedAt")
                .or_else(|| turn.get("createdAt"))
                .and_then(Value::as_i64),
        );
        for (item_index, item) in turn
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            if let Some(message) = app_server_item_message(item, &timestamp, turn_index, item_index)
            {
                messages.push(message);
            }
        }
    }
    messages
}

fn app_server_item_message(
    item: &Value,
    timestamp: &str,
    turn_index: usize,
    item_index: usize,
) -> Option<ChatMessage> {
    let kind = item.get("type")?.as_str()?;
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("codex-{turn_index}-{item_index}"));
    let mut message = app_server_base_message(id, timestamp);
    match kind {
        "userMessage" => {
            message.role = "user".to_string();
            message.content = app_server_content_text(item.get("content"));
        }
        "agentMessage" => {
            message.role = "assistant".to_string();
            message.content = item
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
        }
        "reasoning" => {
            let content = app_server_content_text(item.get("summary"));
            message.role = "reasoning".to_string();
            message.content = if content.is_empty() {
                app_server_content_text(item.get("content"))
            } else {
                content
            };
            message.reasoning = Some(message.content.clone());
        }
        "commandExecution"
        | "fileChange"
        | "mcpToolCall"
        | "dynamicToolCall"
        | "collabToolCall"
        | "collabAgentToolCall"
        | "webSearch"
        | "imageView"
        | "imageGeneration" => {
            message.role = "tool".to_string();
            message.tool_call_id = item.get("id").and_then(Value::as_str).map(str::to_string);
            message.tool_name = Some(app_server_tool_name(kind, item));
            message.tool_input = Some(item.clone());
            message.tool_data = serde_json::to_string(item).ok();
            message.content = app_server_tool_content(kind, item);
            message.is_completed = item
                .get("status")
                .and_then(Value::as_str)
                .map(|status| status != "inProgress");
        }
        _ => return None,
    }
    Some(message)
}

fn app_server_base_message(id: String, timestamp: &str) -> ChatMessage {
    ChatMessage {
        id,
        role: String::new(),
        content: String::new(),
        llm_content: None,
        system_reminder_directory: None,
        timestamp: timestamp.to_string(),
        is_loading: None,
        tool_call_id: None,
        tool_name: None,
        tool_data: None,
        tool_input: None,
        tool_calls: None,
        reasoning: None,
        is_completed: None,
        error_details: None,
        is_collapsed: None,
    }
}

fn app_server_content_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.to_string(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| match part {
                Value::String(text) => Some(text.as_str()),
                _ => part
                    .get("text")
                    .or_else(|| part.get("content"))
                    .and_then(Value::as_str),
            })
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn app_server_tool_name(kind: &str, item: &Value) -> String {
    item.get("tool")
        .or_else(|| item.get("command"))
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(kind)
        .to_string()
}

fn app_server_tool_content(kind: &str, item: &Value) -> String {
    match kind {
        "commandExecution" => item
            .get("aggregatedOutput")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        "mcpToolCall"
        | "dynamicToolCall"
        | "collabToolCall"
        | "collabAgentToolCall"
        | "imageView"
        | "imageGeneration" => item
            .get("result")
            .map(Value::to_string)
            .or_else(|| item.get("error").map(Value::to_string))
            .unwrap_or_default(),
        _ => item
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or(kind)
            .to_string(),
    }
}

fn app_server_timestamp_millis(value: Option<i64>) -> i64 {
    let value = value.unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
    if value.unsigned_abs() < 10_000_000_000 {
        value.saturating_mul(1000)
    } else {
        value
    }
}

fn app_server_timestamp_string(value: Option<i64>) -> String {
    let millis = app_server_timestamp_millis(value);
    chrono::DateTime::from_timestamp_millis(millis)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339()
}

fn paginate_app_server_messages(
    messages: Vec<ChatMessage>,
    before_sequence: Option<i64>,
    limit: i64,
) -> ThreadMessagesPage {
    let limit = limit.clamp(1, 1000) as usize;
    let end = before_sequence
        .map(|sequence| sequence.max(0) as usize)
        .unwrap_or(messages.len())
        .min(messages.len());
    let start = end.saturating_sub(limit);
    ThreadMessagesPage {
        messages: messages[start..end].to_vec(),
        oldest_sequence: (start > 0).then_some(start as i64),
        has_more: start > 0,
        snapshot_sequence: Some(messages.len() as i64),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_known_tool_items_to_stable_flowix_names() {
        let item = json!({
            "id": "item-1",
            "type": "commandExecution",
            "command": "git status --short"
        });
        assert_eq!(
            tool_identity(&item),
            Some(("item-1".to_string(), "command_execution".to_string()))
        );
    }

    #[test]
    fn accepts_current_app_server_tool_item_names() {
        let collab = json!({ "id": "item-c", "type": "collabToolCall", "tool": "spawn_agent" });
        let image = json!({ "id": "item-i", "type": "imageView", "path": "/tmp/image.png" });

        assert_eq!(
            tool_identity(&collab),
            Some(("item-c".to_string(), "collab_agent_tool_call".to_string()))
        );
        assert_eq!(
            tool_identity(&image),
            Some(("item-i".to_string(), "image_generation".to_string()))
        );
    }

    #[test]
    fn serializes_legacy_app_server_sandbox_variants_with_kebab_case() {
        assert_eq!(app_server_sandbox(Some("read-only")), "read-only");
        assert_eq!(
            app_server_sandbox(Some("danger-full-access")),
            "danger-full-access"
        );
        assert_eq!(app_server_sandbox(Some("yolo")), "danger-full-access");
        assert_eq!(app_server_sandbox(None), "workspace-write");
    }

    #[test]
    fn ignores_non_tool_items() {
        assert_eq!(
            tool_identity(&json!({ "id": "message-1", "type": "agentMessage" })),
            None
        );
    }

    #[test]
    fn gives_tool_lifecycle_events_the_provider_item_identity() {
        let metadata = item_metadata(&json!({
            "id": "call-1",
            "type": "commandExecution"
        }));
        assert_eq!(metadata.message_id.as_deref(), Some("call-1"));
        assert_eq!(metadata.source_message_id.as_deref(), Some("call-1"));
    }

    #[test]
    fn projects_rollout_mcp_events_that_are_absent_from_thread_items() {
        let payload = json!({
            "type": "mcp_tool_call_end",
            "call_id": "mcp-call-1",
            "invocation": {
                "server": "flowix",
                "tool": "search",
                "arguments": { "query": "hello" }
            },
            "result": { "Ok": { "content": [{ "type": "text", "text": "done" }] } }
        });

        let message = rollout_mcp_tool_message(&payload, "2026-01-01T00:00:00Z")
            .expect("MCP end event should project to a history row");
        assert_eq!(message.id, "codex-mcp-tool-mcp-call-1");
        assert_eq!(message.role, "tool");
        assert_eq!(message.tool_call_id.as_deref(), Some("mcp-call-1"));
        assert_eq!(message.tool_name.as_deref(), Some("mcp_tool_call"));
        assert_eq!(
            message
                .tool_input
                .as_ref()
                .and_then(|input| input.get("tool")),
            Some(&json!("search")),
        );
    }

    #[test]
    fn projects_rollout_exec_as_the_same_command_tool_used_live() {
        let payload = json!({
            "name": "exec",
            "input": "const r = await tools.exec_command({cmd:\"flowix notebooks --json\",workdir:\"/tmp\"});"
        });

        let presentations = custom_tool_history_presentations(&payload);
        assert_eq!(presentations.len(), 1);
        let (name, input) = &presentations[0];
        assert_eq!(name.as_deref(), Some("command_execution"));
        assert_eq!(
            input.as_ref().and_then(|input| input.get("command")),
            Some(&json!("flowix notebooks --json")),
        );
    }

    #[test]
    fn extracts_quoted_exec_command_keys_without_matching_the_function_name() {
        assert_eq!(
            extract_first_exec_command(
                "const r = await tools.exec_command({\"cmd\":\"flowix notebooks --json\", \"workdir\":\"/tmp\"});"
            ),
            Some("flowix notebooks --json".to_string()),
        );
        assert_eq!(
            extract_first_exec_command(
                "const r = await tools.exec_command({'cmd': 'flowix list work --json'});"
            ),
            Some("flowix list work --json".to_string()),
        );
    }

    #[test]
    fn projects_each_command_inside_a_parallel_exec_wrapper() {
        let payload = json!({
            "name": "exec",
            "input": "const results = await Promise.all([tools.exec_command({cmd: \"git status --short\"}), tools.exec_command({cmd: \"rg --files\"}), tools.exec_command({cmd: \"flowix --help\"})]);"
        });

        let presentations = custom_tool_history_presentations(&payload);
        assert_eq!(presentations.len(), 3);
        assert_eq!(
            presentations[0]
                .1
                .as_ref()
                .and_then(|input| input.get("command")),
            Some(&json!("git status --short")),
        );
        assert_eq!(
            presentations[1]
                .1
                .as_ref()
                .and_then(|input| input.get("command")),
            Some(&json!("rg --files")),
        );
        assert_eq!(
            presentations[2]
                .1
                .as_ref()
                .and_then(|input| input.get("command")),
            Some(&json!("flowix --help")),
        );
    }

    #[test]
    fn turn_scoped_notifications_require_turn_id() {
        assert!(turn_scoped_notification("item/started"));
        assert!(turn_scoped_notification("item/completed"));
        assert!(turn_scoped_notification("turn/completed"));
        assert!(!turn_scoped_notification("thread/status/changed"));
    }

    #[test]
    fn client_messages_omit_the_optional_jsonrpc_header() {
        let message = json!({
            "id": 1,
            "method": "initialize",
            "params": { "clientInfo": { "name": "flowix", "version": "1" } }
        });
        assert!(message.get("jsonrpc").is_none());
    }

    #[test]
    fn projects_app_server_history_without_persisting_it() {
        let thread = json!({
            "turns": [{
                "startedAt": 1_730_910_000,
                "items": [
                    { "id": "u1", "type": "userMessage", "content": [{ "type": "text", "text": "Hello" }] },
                    { "id": "a1", "type": "agentMessage", "text": "Hi" },
                    { "id": "r1", "type": "reasoning", "summary": ["Plan"] },
                    { "id": "c1", "type": "commandExecution", "command": "git status", "status": "completed", "aggregatedOutput": "clean" }
                ]
            }]
        });

        let messages = app_server_turn_messages(
            thread
                .get("turns")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default(),
        );
        assert_eq!(messages.len(), 4);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].content, "Hello");
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[2].reasoning.as_deref(), Some("Plan"));
        assert_eq!(messages[3].tool_name.as_deref(), Some("git status"));
        assert!(messages[3].tool_data.is_some());
    }

    #[test]
    fn pages_projected_history_from_the_newest_messages() {
        let messages = (0..3)
            .map(|index| {
                let mut message =
                    app_server_base_message(index.to_string(), "2026-01-01T00:00:00Z");
                message.role = "assistant".to_string();
                message
            })
            .collect();
        let page = paginate_app_server_messages(messages, None, 2);
        assert_eq!(page.messages.len(), 2);
        assert_eq!(page.messages[0].id, "1");
        assert_eq!(page.oldest_sequence, Some(1));
        assert!(page.has_more);
    }
}
