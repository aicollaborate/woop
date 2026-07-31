use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde_json::Value;
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::Mutex;
use uuid::Uuid;

use super::command::build_opencode_acp_command;
use super::protocol;
use super::AGENT_TYPE;
use crate::agent_external::lifecycle::ExternalLifecycleEmitter;
use crate::agent_external::{
    append_workspace_context, persist_and_emit_external_chunk, persist_external_chunk,
    read_capped_line, read_to_string, resolve_and_freeze_runtime_cwd, truncate_for_log,
    ExternalRunRegistry, MAX_STDOUT_LINE_BYTES, USER_STOPPED_REASON,
};
use crate::agent_flowix::{AgentChunk, AgentUserMessage, RunInfo};
use crate::agent_session::{ChatMessage as ThreadChatMessage, ThreadManager};
use crate::agent_types::AgentId;
use crate::runtime_log;

const APP_EXIT_REASON: &str = "app_exit";

#[derive(Clone)]
struct AcpControl {
    stdin: Arc<Mutex<ChildStdin>>,
    session_id: Arc<Mutex<Option<String>>>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum AcpReadPhase {
    Initialize,
    SessionSetup,
    Prompt,
}

impl AcpReadPhase {
    fn emits_current_turn(self) -> bool {
        self == Self::Prompt
    }
}

pub struct OpenCodeAcpManager {
    thread_manager: Arc<ThreadManager>,
    runs: ExternalRunRegistry,
    controls: Mutex<HashMap<String, AcpControl>>,
}

#[async_trait::async_trait]
impl ExternalLifecycleEmitter for OpenCodeAcpManager {
    fn lifecycle_agent_type(&self) -> &'static str {
        AGENT_TYPE
    }

    async fn emit_and_persist_lifecycle_chunk(
        &self,
        app_handle: &tauri::AppHandle,
        chunk: &AgentChunk,
        run_id: &str,
    ) {
        persist_and_emit_external_chunk(
            app_handle,
            &self.thread_manager,
            AGENT_TYPE,
            chunk,
            run_id,
            None,
        )
        .await;
    }

    async fn persist_emitted_stream_end(&self, chunk: &AgentChunk, run_id: &str) {
        persist_external_chunk(&self.thread_manager, AGENT_TYPE, chunk, run_id, None).await;
    }
}

impl OpenCodeAcpManager {
    pub fn new(thread_manager: Arc<ThreadManager>) -> Self {
        Self {
            thread_manager,
            runs: ExternalRunRegistry::new(AGENT_TYPE, "OpenCode ACP"),
            controls: Mutex::new(HashMap::new()),
        }
    }

    pub async fn chat_stream(
        self: &Arc<Self>,
        thread_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<String, String> {
        let thread_id = thread_id.to_string();
        let start = self
            .runs
            .prepare_start(&thread_id, message.run_id.as_deref())
            .await?;
        let manager = self.clone();
        let app_handle = app_handle.clone();
        let run_id = start.run_id;
        let stream_end_emitted = start.stream_end_emitted;

        tokio::spawn(async move {
            manager
                .emit_stream_start(&app_handle, &thread_id, &message, &run_id)
                .await;
            let reason = match manager
                .run_acp(
                    &thread_id,
                    &run_id,
                    message,
                    &app_handle,
                    stream_end_emitted.clone(),
                )
                .await
            {
                Ok(()) => None,
                Err(error) => {
                    manager
                        .emit_run_error(&app_handle, &thread_id, error.clone(), &run_id)
                        .await;
                    Some(error)
                }
            };
            manager.controls.lock().await.remove(&thread_id);
            manager
                .emit_stream_end(
                    &app_handle,
                    &thread_id,
                    &run_id,
                    reason,
                    &stream_end_emitted,
                )
                .await;
        });

        Ok(String::new())
    }

    pub async fn stop_chat(
        &self,
        thread_id: &str,
        run_id: Option<&str>,
        app_handle: &tauri::AppHandle,
    ) -> bool {
        let mapped_thread_id = self
            .thread_manager
            .find_thread_by_external_session(thread_id, AGENT_TYPE)
            .await
            .ok()
            .flatten();
        let control = {
            let controls = self.controls.lock().await;
            controls.get(thread_id).cloned().or_else(|| {
                mapped_thread_id
                    .as_deref()
                    .and_then(|mapped| controls.get(mapped).cloned())
            })
        };
        if let Some(control) = control {
            if let Some(session_id) = control.session_id.lock().await.clone() {
                let _ = write_message(&control.stdin, &protocol::cancel_notification(&session_id))
                    .await;
            }
        }

        let mut stopped = self
            .runs
            .stop_run(thread_id, thread_id, run_id, "OpenCode ACP")
            .await;
        if stopped.is_none() {
            if let Some(mapped) = mapped_thread_id.as_deref() {
                stopped = self
                    .runs
                    .stop_run(mapped, thread_id, run_id, "OpenCode ACP")
                    .await;
            }
        }
        let Some(stopped) = stopped else {
            return false;
        };
        let mut controls = self.controls.lock().await;
        controls.remove(thread_id);
        if let Some(mapped) = mapped_thread_id {
            controls.remove(&mapped);
        }
        drop(controls);
        self.emit_stream_end(
            app_handle,
            thread_id,
            &stopped.run_id,
            Some(USER_STOPPED_REASON.to_string()),
            &stopped.stream_end_emitted,
        )
        .await;
        true
    }

    pub async fn running_threads(&self) -> HashMap<String, RunInfo> {
        self.runs.running_threads().await
    }

    pub async fn stop_all(&self) -> usize {
        self.controls.lock().await.clear();
        let (count, finalized) = self
            .runs
            .kill_all_finalized("OpenCode ACP", APP_EXIT_REASON)
            .await;
        for run in finalized {
            let run_id = run.run_id.unwrap_or_else(|| run.thread_id.clone());
            persist_external_chunk(
                &self.thread_manager,
                AGENT_TYPE,
                &AgentChunk::StreamEnd {
                    thread_id: run.thread_id,
                    reason: run.reason,
                },
                &run_id,
                None,
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
        let finalized = self
            .runs
            .reap_inactive(idle_timeout_ms, "OpenCode ACP")
            .await;
        if !finalized.is_empty() {
            let mut controls = self.controls.lock().await;
            for run in &finalized {
                controls.remove(&run.thread_id);
            }
        }
        self.emit_watchdog_finalized(app_handle, &finalized).await;
        finalized.len()
    }

    async fn run_acp(
        &self,
        thread_id: &str,
        run_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
        stream_end_emitted: Arc<AtomicBool>,
    ) -> Result<(), String> {
        let stored_session = self
            .thread_manager
            .get_external_session(thread_id, AGENT_TYPE)
            .await
            .map_err(|error| error.to_string())?;
        let reverse_mapping = if stored_session.is_none() {
            self.thread_manager
                .find_thread_by_external_session(thread_id, AGENT_TYPE)
                .await
                .map_err(|error| error.to_string())?
        } else {
            None
        };
        let mapped_session =
            select_resumable_session(thread_id, stored_session, reverse_mapping.is_some());
        let product_thread_id = reverse_mapping.as_deref().unwrap_or(thread_id);
        self.ensure_product_thread(product_thread_id).await?;
        let cwd = resolve_and_freeze_runtime_cwd(
            &self.thread_manager,
            product_thread_id,
            |message, _| {
                message
                    .cwd_for_runtime(AGENT_TYPE)
                    .map(PathBuf::from)
                    .filter(|path| path.is_dir())
            },
            &message,
            mapped_session.as_deref(),
            None,
        )
        .await?;
        let additional_directories = normalized_additional_directories(
            &cwd,
            &message.workspace_paths_for_runtime(AGENT_TYPE),
        );
        let permission_mode = message
            .permission_mode_for_runtime(AGENT_TYPE)
            .map(str::to_string);
        let workspace_paths = message.workspace_paths_for_runtime(AGENT_TYPE);
        let user_prompt = message
            .llm_content
            .clone()
            .unwrap_or(message.content.clone());
        let prompt = append_workspace_context(&user_prompt, &cwd, &workspace_paths);
        self.persist_user_message(product_thread_id, &message, &prompt)
            .await?;

        let mut child = build_opencode_acp_command(&cwd, permission_mode.as_deref())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("failed to start OpenCode ACP: {error}"))?;
        let child_pid = child.id();
        let stdin =
            Arc::new(Mutex::new(child.stdin.take().ok_or_else(|| {
                "failed to capture OpenCode ACP stdin".to_string()
            })?));
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to capture OpenCode ACP stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "failed to capture OpenCode ACP stderr".to_string())?;
        let session_slot = Arc::new(Mutex::new(None));

        if let Err(mut duplicate) = self
            .runs
            .try_insert(
                thread_id.to_string(),
                child,
                Some(run_id.to_string()),
                stream_end_emitted,
            )
            .await
        {
            let _ = duplicate.kill().await;
            return Err("OpenCode ACP is already running for this thread".to_string());
        }
        self.controls.lock().await.insert(
            thread_id.to_string(),
            AcpControl {
                stdin: stdin.clone(),
                session_id: session_slot.clone(),
            },
        );

        runtime_log::record_agent_event(
            "info",
            "opencode_acp",
            "opencode.acp_spawned",
            "OpenCode ACP process started",
            Some(thread_id),
            Some(AGENT_TYPE),
            Some(serde_json::json!({
                "child_pid": child_pid,
                "cwd": cwd,
                "session_mode": if mapped_session.is_some() { "load" } else { "new" },
                "session_id": mapped_session,
                "additional_directories": additional_directories,
                "permission_mode": permission_mode
            })),
        );

        let stderr_task = tokio::spawn(read_to_string(BufReader::new(stderr)));
        let mut stdout = BufReader::new(stdout);
        let mut tool_names = HashMap::new();
        let mut assistant_text = String::new();
        let mut allowed_roots = vec![cwd.clone()];
        allowed_roots.extend(additional_directories.iter().map(PathBuf::from));

        let protocol_result = async {
            write_message(&stdin, &protocol::initialize_request()).await?;
            let initialize_result = self
                .read_until_response(
                    thread_id,
                    run_id,
                    permission_mode.as_deref(),
                    app_handle,
                    &stdin,
                    &mut stdout,
                    protocol::INITIALIZE_ID,
                    AcpReadPhase::Initialize,
                    &allowed_roots,
                    &mut tool_names,
                    &mut assistant_text,
                )
                .await?;
            let negotiated_protocol = initialize_result
                .get("protocolVersion")
                .and_then(Value::as_u64);
            if negotiated_protocol != Some(protocol::PROTOCOL_VERSION) {
                return Err(format!(
                    "OpenCode ACP negotiated unsupported protocol version: {}",
                    negotiated_protocol
                        .map(|version| version.to_string())
                        .unwrap_or_else(|| "missing".to_string())
                ));
            }
            let can_load_session = initialize_result
                .pointer("/agentCapabilities/loadSession")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let resumable_session = mapped_session.as_deref().filter(|_| can_load_session);

            let cwd_text = cwd.to_string_lossy().to_string();
            let session_request = if let Some(session_id) = resumable_session {
                protocol::load_session_request(session_id, &cwd_text, &additional_directories)
            } else {
                protocol::new_session_request(&cwd_text, &additional_directories)
            };
            write_message(&stdin, &session_request).await?;
            let session_result = self
                .read_until_response(
                    thread_id,
                    run_id,
                    permission_mode.as_deref(),
                    app_handle,
                    &stdin,
                    &mut stdout,
                    protocol::SESSION_ID,
                    AcpReadPhase::SessionSetup,
                    &allowed_roots,
                    &mut tool_names,
                    &mut assistant_text,
                )
                .await?;
            let session_id = protocol::session_id_from_result(&session_result)
                .or_else(|| resumable_session.map(str::to_string))
                .ok_or_else(|| "OpenCode ACP did not return a session id".to_string())?;
            *session_slot.lock().await = Some(session_id.clone());
            self.runs
                .set_session_id(thread_id, Some(run_id), session_id.clone())
                .await;
            self.thread_manager
                .upsert_external_session(
                    thread_id,
                    AGENT_TYPE,
                    &session_id,
                    Some(session_result.clone()),
                )
                .await
                .map_err(|error| error.to_string())?;
            self.emit_and_persist_lifecycle_chunk(
                app_handle,
                &AgentChunk::SessionResolved {
                    thread_id: thread_id.to_string(),
                    session_id: session_id.clone(),
                },
                run_id,
            )
            .await;

            write_message(
                &stdin,
                &protocol::prompt_request(&session_id, &prompt, &message.image_paths),
            )
            .await?;
            self.read_until_response(
                thread_id,
                run_id,
                permission_mode.as_deref(),
                app_handle,
                &stdin,
                &mut stdout,
                protocol::PROMPT_ID,
                AcpReadPhase::Prompt,
                &allowed_roots,
                &mut tool_names,
                &mut assistant_text,
            )
            .await?;
            self.persist_assistant_message(product_thread_id, &assistant_text)
                .await?;
            Ok(())
        }
        .await;

        self.controls.lock().await.remove(thread_id);
        if let Some(mut running) = self.runs.remove_if_run_id(thread_id, Some(run_id)).await {
            crate::agent_external::shared::kill_child_tree(
                &mut running.child,
                "OpenCode ACP",
                thread_id,
            )
            .await;
            let _ = running.child.wait().await;
        }
        let stderr_text = stderr_task
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or_default();
        if !stderr_text.trim().is_empty() {
            runtime_log::record_agent_event(
                "info",
                "opencode_acp",
                "opencode.acp_stderr",
                "OpenCode ACP wrote diagnostic output",
                Some(thread_id),
                Some(AGENT_TYPE),
                Some(serde_json::json!({
                    "stderr_preview": truncate_for_log(stderr_text.trim())
                })),
            );
        }
        protocol_result
    }

    #[allow(clippy::too_many_arguments)]
    async fn read_until_response(
        &self,
        thread_id: &str,
        run_id: &str,
        permission_mode: Option<&str>,
        app_handle: &tauri::AppHandle,
        stdin: &Arc<Mutex<ChildStdin>>,
        stdout: &mut BufReader<tokio::process::ChildStdout>,
        response_id: u64,
        phase: AcpReadPhase,
        allowed_roots: &[PathBuf],
        tool_names: &mut HashMap<String, String>,
        assistant_text: &mut String,
    ) -> Result<Value, String> {
        loop {
            let Some((line, truncated)) = read_capped_line(stdout, MAX_STDOUT_LINE_BYTES).await?
            else {
                return Err(format!(
                    "OpenCode ACP closed before responding to request {response_id}"
                ));
            };
            self.runs.touch(thread_id, Some(run_id)).await;
            if truncated {
                return Err("OpenCode ACP emitted an oversized JSON-RPC message".to_string());
            }
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let value: Value = serde_json::from_str(line)
                .map_err(|error| format!("invalid OpenCode ACP JSON-RPC: {error}"))?;

            if let Some(response) =
                protocol::permission_response(&value, permission_mode, allowed_roots)
            {
                write_message(stdin, &response).await?;
                continue;
            }
            if let Some(response) = protocol::unsupported_request_response(&value) {
                write_message(stdin, &response).await?;
                continue;
            }
            if !phase.emits_current_turn() {
                if let Some(result) = protocol::response_result(&value, response_id) {
                    return result.cloned();
                }
                continue;
            }
            for mut chunk in protocol::chunks_from_message(thread_id, &value) {
                if let AgentChunk::Text { text, .. } = &chunk {
                    assistant_text.push_str(text);
                }
                remember_tool_name(&mut chunk, tool_names);
                persist_and_emit_external_chunk(
                    app_handle,
                    &self.thread_manager,
                    AGENT_TYPE,
                    &chunk,
                    run_id,
                    Some(line),
                )
                .await;
            }
            if let Some(result) = protocol::response_result(&value, response_id) {
                return result.cloned();
            }
        }
    }

    async fn persist_user_message(
        &self,
        thread_id: &str,
        message: &AgentUserMessage,
        llm_content: &str,
    ) -> Result<(), String> {
        self.ensure_product_thread(thread_id).await?;
        self.thread_manager
            .add_message(
                thread_id,
                ThreadChatMessage {
                    id: format!("user_{}", Uuid::new_v4()),
                    role: "user".to_string(),
                    content: message.content.clone(),
                    llm_content: Some(llm_content.to_string()),
                    system_reminder_directory: message.system_reminder_directory.clone(),
                    timestamp: chrono::Utc::now().to_rfc3339(),
                    is_loading: None,
                    tool_call_id: None,
                    tool_name: None,
                    tool_data: None,
                    tool_input: None,
                    tool_calls: None,
                    reasoning: None,
                    is_completed: Some(true),
                    is_collapsed: None,
                },
            )
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    async fn ensure_product_thread(&self, thread_id: &str) -> Result<(), String> {
        self.thread_manager
            .ensure_thread(
                thread_id,
                AgentId(AGENT_TYPE.to_string()),
                "OpenCode session".to_string(),
            )
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    async fn persist_assistant_message(&self, thread_id: &str, text: &str) -> Result<(), String> {
        if text.trim().is_empty() {
            return Ok(());
        }
        self.thread_manager
            .add_message(
                thread_id,
                ThreadChatMessage {
                    id: format!("assistant_{}", Uuid::new_v4()),
                    role: "assistant".to_string(),
                    content: text.to_string(),
                    llm_content: None,
                    system_reminder_directory: None,
                    timestamp: chrono::Utc::now().to_rfc3339(),
                    is_loading: None,
                    tool_call_id: None,
                    tool_name: None,
                    tool_data: None,
                    tool_input: None,
                    tool_calls: None,
                    reasoning: None,
                    is_completed: Some(true),
                    is_collapsed: None,
                },
            )
            .await
            .map_err(|error| error.to_string())
    }
}

fn remember_tool_name(chunk: &mut AgentChunk, tool_names: &mut HashMap<String, String>) {
    match chunk {
        AgentChunk::ToolCall { id, name, .. } => {
            if let Some(original) = tool_names.get(id) {
                *name = original.clone();
            } else {
                tool_names.insert(id.clone(), name.clone());
            }
        }
        AgentChunk::ToolResult { id, name, .. } => {
            if let Some(original) = tool_names.get(id) {
                *name = original.clone();
            }
        }
        _ => {}
    }
}

fn select_resumable_session(
    thread_id: &str,
    stored_session: Option<String>,
    thread_id_is_external_session: bool,
) -> Option<String> {
    stored_session.or_else(|| thread_id_is_external_session.then(|| thread_id.to_string()))
}

async fn write_message(stdin: &Arc<Mutex<ChildStdin>>, message: &Value) -> Result<(), String> {
    let mut serialized = serde_json::to_vec(message).map_err(|error| error.to_string())?;
    serialized.push(b'\n');
    let mut stdin = stdin.lock().await;
    stdin
        .write_all(&serialized)
        .await
        .map_err(|error| format!("failed to write OpenCode ACP message: {error}"))?;
    stdin
        .flush()
        .await
        .map_err(|error| format!("failed to flush OpenCode ACP message: {error}"))
}

fn normalized_additional_directories(cwd: &std::path::Path, paths: &[String]) -> Vec<String> {
    let cwd = cwd
        .to_string_lossy()
        .trim_end_matches(['/', '\\'])
        .to_string();
    let mut seen = std::collections::HashSet::new();
    paths
        .iter()
        .map(|path| path.trim().trim_end_matches(['/', '\\']).to_string())
        .filter(|path| !path.is_empty() && path != &cwd)
        .filter(|path| std::path::Path::new(path).is_dir())
        .filter(|path| seen.insert(path.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resumes_when_frontend_uses_the_canonical_session_id() {
        assert_eq!(
            select_resumable_session("session-123", None, true).as_deref(),
            Some("session-123")
        );
    }

    #[test]
    fn stored_product_mapping_wins_over_thread_id_hint() {
        assert_eq!(
            select_resumable_session("product-thread", Some("session-456".into()), false)
                .as_deref(),
            Some("session-456")
        );
    }

    #[test]
    fn only_prompt_phase_emits_current_turn_chunks() {
        assert!(!AcpReadPhase::Initialize.emits_current_turn());
        assert!(!AcpReadPhase::SessionSetup.emits_current_turn());
        assert!(AcpReadPhase::Prompt.emits_current_turn());
    }

    #[test]
    fn completed_tool_update_reuses_the_original_name() {
        let mut names = HashMap::new();
        let mut call = AgentChunk::ToolCall {
            thread_id: "thread".into(),
            id: "call-1".into(),
            name: "Read file".into(),
            input: Value::Null,
        };
        remember_tool_name(&mut call, &mut names);
        let mut result = AgentChunk::ToolResult {
            thread_id: "thread".into(),
            id: "call-1".into(),
            name: "C:\\workspace\\example.txt".into(),
            result: Value::Null,
        };
        remember_tool_name(&mut result, &mut names);
        assert!(matches!(
            result,
            AgentChunk::ToolResult { name, .. } if name == "Read file"
        ));
    }

    #[test]
    fn completed_tool_call_update_reuses_the_original_name() {
        let mut names = HashMap::new();
        let mut initial = AgentChunk::ToolCall {
            thread_id: "thread".into(),
            id: "call-1".into(),
            name: "read".into(),
            input: serde_json::json!({}),
        };
        remember_tool_name(&mut initial, &mut names);

        let mut completed = AgentChunk::ToolCall {
            thread_id: "thread".into(),
            id: "call-1".into(),
            name: "C:\\workspace\\example.txt".into(),
            input: serde_json::json!({ "filePath": "C:\\workspace\\example.txt" }),
        };
        remember_tool_name(&mut completed, &mut names);

        assert!(matches!(
            completed,
            AgentChunk::ToolCall { name, input, .. }
                if name == "read"
                    && input["filePath"] == "C:\\workspace\\example.txt"
        ));
    }
}
