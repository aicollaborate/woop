use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, BufReader};
use tokio::process::Command;
use uuid::Uuid;

use super::super::lifecycle::ExternalLifecycleEmitter;
use crate::agent_external::cli_resolver::{
    no_extra_candidates, resolve_external_cli, ExternalCliSpec,
};
use crate::agent_external::{
    append_workspace_context, default_thread_title, emit_chunk_with_run_id, read_to_string,
    resolve_and_freeze_runtime_cwd, truncate_for_log, ExternalRunRegistry, USER_STOPPED_REASON,
};
use crate::agent_flowix::{AgentChunk, AgentId, AgentUserMessage};
use crate::agent_session::{ChatMessage as ThreadChatMessage, ThreadManager};
use crate::runtime_log;

/// 8 MiB cap on simple_cli stdout accumulation. Different from Codex/Claude
/// (whose stdout is line-JSON and bounded by `MAX_STDOUT_LINE_BYTES`); here
/// stdout is the assistant answer streamed back verbatim. 8 MiB is large
/// enough for any realistic response yet small enough to keep us honest
/// against a misbehaving CLI that streams without end.
const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug)]
pub enum SimpleCliKind {
    Gemini,
    OpenClaw,
}

impl SimpleCliKind {
    pub fn key(self) -> &'static str {
        match self {
            Self::Gemini => "gemini",
            Self::OpenClaw => "openclaw",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::Gemini => "Gemini CLI",
            Self::OpenClaw => "OpenClaw",
        }
    }

    fn cli_spec(self) -> &'static ExternalCliSpec {
        match self {
            Self::Gemini => &GEMINI_CLI_SPEC,
            Self::OpenClaw => &OPENCLAW_CLI_SPEC,
        }
    }

    /// Category prefix used by `runtime_log::record_agent_event` for this
    /// vendor. Keeping the prefix short lets ops grep `simple_cli_process:`
    /// once and get all three vendors together when needed.
    fn log_category(self) -> &'static str {
        "simple_cli_process"
    }
}

const GEMINI_CLI_SPEC: ExternalCliSpec = ExternalCliSpec {
    binary_name: "gemini",
    #[cfg(windows)]
    windows_binary_name: "gemini.cmd",
    env_vars: &["GEMINI_CLI_PATH"],
    extra_unix_candidates: no_extra_candidates,
    #[cfg(windows)]
    extra_windows_candidates: no_extra_candidates,
};

const OPENCLAW_CLI_SPEC: ExternalCliSpec = ExternalCliSpec {
    binary_name: "openclaw",
    #[cfg(windows)]
    windows_binary_name: "openclaw.cmd",
    env_vars: &["OPENCLAW_CLI_PATH"],
    extra_unix_candidates: no_extra_candidates,
    #[cfg(windows)]
    extra_windows_candidates: no_extra_candidates,
};

pub struct SimpleCliManager {
    kind: SimpleCliKind,
    thread_manager: Arc<ThreadManager>,
    runs: ExternalRunRegistry,
}

#[async_trait::async_trait]
impl ExternalLifecycleEmitter for SimpleCliManager {
    fn lifecycle_agent_type(&self) -> &'static str {
        self.kind.key()
    }

    async fn emit_and_persist_lifecycle_chunk(
        &self,
        app_handle: &tauri::AppHandle,
        chunk: &AgentChunk,
        run_id: &str,
    ) {
        // Gemini/OpenClaw deliberately do not persist raw external events.
        emit_chunk_with_run_id(app_handle, chunk, self.kind.key(), run_id);
    }
}

impl SimpleCliManager {
    pub fn new(kind: SimpleCliKind, thread_manager: Arc<ThreadManager>) -> Self {
        let key = kind.key();
        Self {
            kind,
            thread_manager,
            runs: ExternalRunRegistry::new(key, key),
        }
    }

    pub fn runtime_key(&self) -> &'static str {
        self.kind.key()
    }

    /// Idle-watchdog hook (called by `app::watchdog`). Mirrors the Claude/Codex
    /// managers: `reap_inactive` already claimed the StreamEnd slot under its
    /// lock, so we emit Error + StreamEnd directly. Uses `emit_chunk_with_run_id`
    /// (not `persist_*`) to match this runtime's own streaming path, which does
    /// not persist raw events. Without this, a hung Gemini/OpenClaw child would
    /// never be reaped (the watchdog previously only swept Claude/Codex).
    pub async fn reap_inactive_runs(
        &self,
        app_handle: &tauri::AppHandle,
        idle_timeout_ms: i64,
    ) -> usize {
        let finalized = self
            .runs
            .reap_inactive(idle_timeout_ms, self.kind.display_name())
            .await;
        self.emit_watchdog_finalized(app_handle, &finalized).await;
        finalized.len()
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
        let app_handle = app_handle.clone();
        let manager = self.clone();
        let run_id = start.run_id;
        let stream_end_emitted = start.stream_end_emitted;

        tokio::spawn(async move {
            manager
                .emit_stream_start(&app_handle, &thread_id, &message, &run_id)
                .await;

            let reason = match manager
                .run_cli(
                    &thread_id,
                    &run_id,
                    message,
                    &app_handle,
                    stream_end_emitted.clone(),
                )
                .await
            {
                Ok(()) => None,
                Err(err) => {
                    manager
                        .emit_run_error(&app_handle, &thread_id, err.clone(), &run_id)
                        .await;
                    Some(err)
                }
            };

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
        let Some(stopped) = self
            .runs
            .stop_run(thread_id, thread_id, run_id, self.kind.display_name())
            .await
        else {
            return false;
        };

        let run_id_for_chunk = stopped.run_id;
        self.emit_stream_end(
            app_handle,
            thread_id,
            &run_id_for_chunk,
            Some(USER_STOPPED_REASON.to_string()),
            &stopped.stream_end_emitted,
        )
        .await;
        true
    }

    pub async fn running_threads(&self) -> HashMap<String, crate::agent_flowix::RunInfo> {
        self.runs.running_threads().await
    }

    pub async fn stop_all(&self) -> usize {
        self.runs.kill_all(self.kind.display_name()).await
    }

    async fn run_cli(
        &self,
        thread_id: &str,
        run_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
        stream_end_emitted: Arc<AtomicBool>,
    ) -> Result<(), String> {
        let runtime_key = self.kind.key();
        let cwd = {
            resolve_and_freeze_runtime_cwd(
                &self.thread_manager,
                thread_id,
                |m, _| {
                    m.cwd_for_runtime(runtime_key)
                        .map(PathBuf::from)
                        .filter(|p| p.is_dir())
                },
                &message,
                None,
                None,
            )
            .await?
        };
        let workspace_paths = message.workspace_paths_for_runtime(self.kind.key());
        let user_prompt = message
            .llm_content
            .clone()
            .unwrap_or_else(|| message.content.clone());
        let prompt = append_workspace_context(&user_prompt, &cwd, &workspace_paths);

        runtime_log::record_agent_event(
            "info",
            self.kind.log_category(),
            "simple_cli.spawn_start",
            &format!("Starting {}", self.kind.display_name()),
            Some(thread_id),
            Some(self.kind.key()),
            Some(serde_json::json!({
                "run_id": run_id,
                "cwd": cwd.display().to_string(),
                "workspace_paths": workspace_paths,
                "prompt_chars": prompt.chars().count(),
            })),
        );

        self.persist_user_message(thread_id, &user_prompt, &message)
            .await?;

        let result =
            async {
                let mut child = build_command(self.kind, &cwd, &prompt)
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .spawn()
                    .map_err(|e| format!("failed to start {}: {e}", self.kind.display_name()))?;
                let child_pid = child.id();
                runtime_log::record_agent_event(
                    "info",
                    self.kind.log_category(),
                    "simple_cli.spawn_ok",
                    &format!("{} process started", self.kind.display_name()),
                    Some(thread_id),
                    Some(self.kind.key()),
                    Some(serde_json::json!({
                        "run_id": run_id,
                        "child_pid": child_pid,
                    })),
                );

                drop(child.stdin.take());

                let stdout = child.stdout.take().ok_or_else(|| {
                    format!("failed to capture {} stdout", self.kind.display_name())
                })?;
                let stderr = child.stderr.take().ok_or_else(|| {
                    format!("failed to capture {} stderr", self.kind.display_name())
                })?;

                if let Err(mut duplicate_child) = self
                    .runs
                    .try_insert(
                        thread_id.to_string(),
                        child,
                        Some(run_id.to_string()),
                        stream_end_emitted,
                    )
                    .await
                {
                    let _ = duplicate_child.kill().await;
                    return Err(format!(
                        "{} is already running for this thread",
                        self.kind.display_name()
                    ));
                }

                let stdout_task = read_stdout_as_text(
                    thread_id.to_string(),
                    run_id.to_string(),
                    app_handle.clone(),
                    self.kind.key(),
                    BufReader::new(stdout),
                );
                let stderr_task = read_to_string(BufReader::new(stderr));
                let (stdout_result, stderr_text) = tokio::join!(stdout_task, stderr_task);

                let mut running = self.runs.remove_if_run_id(thread_id, Some(run_id)).await;
                let status = if let Some(running) = running.as_mut() {
                    running.child.wait().await.map_err(|e| e.to_string())?
                } else {
                    runtime_log::record_agent_event(
                        "warn",
                        self.kind.log_category(),
                        "simple_cli.child_missing_after_run",
                        "Child removed before wait; likely stopped by user",
                        Some(thread_id),
                        Some(self.kind.key()),
                        Some(serde_json::json!({
                            "run_id": run_id,
                            "child_pid": child_pid,
                        })),
                    );
                    return Ok(());
                };

                let assistant_text = stdout_result?;
                let stderr_text = stderr_text.unwrap_or_default();
                runtime_log::record_agent_event(
                    if status.success() { "info" } else { "error" },
                    self.kind.log_category(),
                    "simple_cli.exit",
                    &format!("{} process exited", self.kind.display_name()),
                    Some(thread_id),
                    Some(self.kind.key()),
                    Some(serde_json::json!({
                        "run_id": run_id,
                        "child_pid": child_pid,
                        "success": status.success(),
                        "code": status.code(),
                        "stderr_chars": stderr_text.chars().count(),
                        "stderr_preview": truncate_for_log(stderr_text.trim()),
                    })),
                );
                if !status.success() {
                    let detail = stderr_text.trim();
                    return Err(if detail.is_empty() {
                        format!("{} exited with status {status}", self.kind.display_name())
                    } else {
                        format!(
                            "{} exited with status {status}: {detail}",
                            self.kind.display_name()
                        )
                    });
                }
                if !stderr_text.trim().is_empty() {
                    tracing::info!(
                        "[{}] stderr: {}",
                        self.kind.display_name(),
                        stderr_text.trim()
                    );
                }
                self.persist_assistant_message(thread_id, &assistant_text)
                    .await?;
                Ok(())
            }
            .await;

        if let Err(err) = &result {
            if let Err(persist_err) = self.persist_error_message(thread_id, err).await {
                tracing::warn!(
                    "[{}] failed to persist error message for {thread_id}: {persist_err}",
                    self.kind.display_name()
                );
            }
        }

        result
    }

    async fn persist_user_message(
        &self,
        thread_id: &str,
        prompt: &str,
        message: &AgentUserMessage,
    ) -> Result<(), String> {
        let manager = &self.thread_manager;
        manager
            .ensure_thread(
                thread_id,
                AgentId(self.kind.key().to_string()),
                default_thread_title(self.kind.display_name(), prompt),
            )
            .await
            .map_err(|e| e.to_string())?;
        manager
            .add_message(
                thread_id,
                ThreadChatMessage {
                    id: format!("user_{}", Uuid::new_v4()),
                    role: "user".to_string(),
                    content: prompt.to_string(),
                    llm_content: Some(prompt.to_string()),
                    system_reminder_directory: message.system_reminder_directory.clone(),
                    timestamp: chrono::Utc::now().to_rfc3339(),
                    is_loading: None,
                    tool_call_id: None,
                    tool_name: None,
                    tool_data: None,
                    tool_input: None,
                    tool_calls: None,
                    reasoning: None,
                    is_completed: None,
                    is_collapsed: None,
                },
            )
            .await
            .map_err(|e| e.to_string())
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
                    is_completed: None,
                    is_collapsed: None,
                },
            )
            .await
            .map_err(|e| e.to_string())
    }

    async fn persist_error_message(&self, thread_id: &str, error: &str) -> Result<(), String> {
        let text = format!("Error: {}", error.trim());
        self.persist_assistant_message(thread_id, &text).await
    }
}

fn build_command(kind: SimpleCliKind, cwd: &Path, prompt: &str) -> Command {
    let mut cmd = Command::new(resolve_simple_cli_binary(kind));
    crate::process_window::hide_command_window(&mut cmd);
    cmd.current_dir(cwd);
    cmd.args(command_args(kind, prompt));
    crate::agent_external::shared::configure_unix_process_group(&mut cmd);
    cmd
}

fn command_args(kind: SimpleCliKind, prompt: &str) -> Vec<String> {
    match kind {
        SimpleCliKind::Gemini => vec!["-p".to_string(), prompt.to_string()],
        SimpleCliKind::OpenClaw => {
            let agent_id =
                std::env::var("OPENCLAW_AGENT_ID").unwrap_or_else(|_| "main".to_string());
            vec![
                "agent".to_string(),
                "--agent".to_string(),
                agent_id,
                "--message".to_string(),
                prompt.to_string(),
            ]
        }
    }
}

pub(crate) fn resolve_simple_cli_binary(kind: SimpleCliKind) -> PathBuf {
    resolve_external_cli(kind.cli_spec())
}

async fn read_stdout_as_text<R>(
    thread_id: String,
    run_id: String,
    app_handle: tauri::AppHandle,
    agent_type: &'static str,
    reader: BufReader<R>,
) -> Result<String, String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut reader = reader;
    let mut buffer = [0_u8; 4096];
    let mut output = String::new();
    let mut total_bytes: usize = 0;
    loop {
        let n = reader.read(&mut buffer).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        let text = String::from_utf8_lossy(&buffer[..n]).to_string();
        emit_chunk_with_run_id(
            &app_handle,
            &AgentChunk::Text {
                thread_id: thread_id.clone(),
                text: text.clone(),
            },
            agent_type,
            &run_id,
        );
        output.push_str(&text);
        total_bytes = total_bytes.saturating_add(n);
        if total_bytes >= MAX_OUTPUT_BYTES {
            runtime_log::record_agent_event(
                "warn",
                "simple_cli_stdout",
                "simple_cli.stdout_truncated",
                "Simple cli stdout exceeded soft cap; further bytes dropped",
                Some(&thread_id),
                Some(agent_type),
                Some(serde_json::json!({
                    "run_id": run_id,
                    "max_bytes": MAX_OUTPUT_BYTES,
                })),
            );
            // Drain remaining bytes without emitting so the child still sees
            // its stdio closed; the accumulated `output` is what's persisted.
            let mut drain = [0_u8; 4096];
            loop {
                match reader.read(&mut drain).await {
                    Ok(0) => break,
                    Ok(_) => continue,
                    Err(_) => break,
                }
            }
            break;
        }
    }
    runtime_log::record_agent_event(
        "info",
        "simple_cli_stdout",
        "simple_cli.stdout_eof",
        "Simple cli stdout reached EOF",
        Some(&thread_id),
        Some(agent_type),
        Some(serde_json::json!({
            "run_id": run_id,
            "total_bytes": total_bytes,
        })),
    );
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_args_match_cli_contracts() {
        assert_eq!(
            command_args(SimpleCliKind::Gemini, "hello"),
            vec!["-p", "hello"]
        );
        assert_eq!(
            command_args(SimpleCliKind::OpenClaw, "hello"),
            vec!["agent", "--agent", "main", "--message", "hello"]
        );
    }

    #[test]
    fn default_thread_title_collapses_whitespace_and_truncates() {
        assert_eq!(
            default_thread_title(SimpleCliKind::Gemini.display_name(), "  fix   this now  "),
            "fix this now"
        );
        assert_eq!(
            default_thread_title(
                SimpleCliKind::OpenClaw.display_name(),
                "abcdefghijklmnopqrstuvwxyz123456"
            ),
            "abcdefghijklmnopqrstuvwxyz12"
        );
    }
}
