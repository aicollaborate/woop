use std::collections::HashMap;
#[cfg(test)]
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::io::{AsyncWriteExt, BufReader};

use super::super::lifecycle::ExternalLifecycleEmitter;
pub(crate) use super::binary::resolve_codex_binary;
#[cfg(test)]
use super::command::{
    build_codex_command, is_executable_file, latest_versioned_subdir, normalized_codex_model,
    normalized_permission_mode, normalized_reasoning_effort, parse_node_version,
    resolve_node_binary, which_codex,
};
use super::command::{build_codex_command_with_images, resolve_codex_cwd};
pub(crate) use super::command::{build_codex_entrypoint, preflight_codex};
use super::history::is_codex_session_id;
use super::runtime::{diagnostics_enabled, persist_and_emit_codex_chunk, persist_codex_chunk};
use super::stream::read_codex_stdout;
use super::AGENT_TYPE;
use crate::agent_external::{
    read_stderr_to_string, resolve_and_freeze_runtime_cwd, select_external_session_for_runtime,
    truncate_for_log, ExternalRunRegistry, USER_STOPPED_REASON,
};
use crate::agent_flowix::{AgentChunk, AgentUserMessage};
use crate::agent_session::ThreadManager;
use crate::runtime_log;

pub struct CodexCliManager {
    thread_manager: Arc<ThreadManager>,
    runs: ExternalRunRegistry,
}

#[async_trait::async_trait]
impl ExternalLifecycleEmitter for CodexCliManager {
    fn lifecycle_agent_type(&self) -> &'static str {
        AGENT_TYPE
    }

    async fn emit_and_persist_lifecycle_chunk(
        &self,
        app_handle: &tauri::AppHandle,
        chunk: &AgentChunk,
        run_id: &str,
    ) {
        persist_and_emit_codex_chunk(app_handle, &self.thread_manager, chunk, run_id, None).await;
    }

    async fn persist_emitted_stream_end(&self, chunk: &AgentChunk, run_id: &str) {
        persist_codex_chunk(&self.thread_manager, chunk, run_id, None).await;
    }
}

impl CodexCliManager {
    pub fn new(thread_manager: Arc<ThreadManager>) -> Self {
        Self {
            thread_manager,
            runs: ExternalRunRegistry::new(AGENT_TYPE, AGENT_TYPE),
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
        let app_handle = app_handle.clone();
        let manager = self.clone();
        let run_id = start.run_id;
        let stream_end_emitted = start.stream_end_emitted;

        tokio::spawn(async move {
            manager
                .emit_user_message(&app_handle, &thread_id, &message, &run_id)
                .await;
            manager
                .emit_stream_start(&app_handle, &thread_id, &message, &run_id)
                .await;

            let reason = match manager
                .run_codex(
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
        let mut event_thread_id = thread_id.to_string();
        let mut stopped = self
            .runs
            .stop_run(thread_id, thread_id, run_id, "CodexCli")
            .await;
        if stopped.is_none() {
            let mapped_thread_id = {
                self.thread_manager
                    .find_thread_by_external_session(thread_id, AGENT_TYPE)
                    .await
                    .ok()
                    .flatten()
            };
            if let Some(mapped_thread_id) = mapped_thread_id {
                if mapped_thread_id != thread_id {
                    stopped = self
                        .runs
                        .stop_run(&mapped_thread_id, thread_id, run_id, "CodexCli")
                        .await;
                    if stopped.is_some() {
                        event_thread_id = mapped_thread_id;
                    }
                }
            }
        }
        let Some(stopped) = stopped else {
            return false;
        };

        // 不等流式任务�?��醒来 ── 用户停�?后立刻发 StreamEnd。共�?flag �?        // task body �?��的兜�?emit �?��跳过 (避免重�?事件)�?
        let run_id_for_chunk = stopped.run_id;
        self.emit_stream_end(
            app_handle,
            &event_thread_id,
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
        self.runs.kill_all("CodexCli").await
    }

    pub async fn reap_inactive_runs(
        &self,
        app_handle: &tauri::AppHandle,
        idle_timeout_ms: i64,
    ) -> usize {
        let finalized = self.runs.reap_inactive(idle_timeout_ms, "CodexCli").await;
        self.emit_watchdog_finalized(app_handle, &finalized).await;
        finalized.len()
    }

    async fn run_codex(
        &self,
        thread_id: &str,
        run_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
        stream_end_emitted: Arc<AtomicBool>,
    ) -> Result<(), String> {
        let mapped_session_id = {
            self.thread_manager
                .get_external_session(thread_id, AGENT_TYPE)
                .await
                .map_err(|e| e.to_string())?
        };
        let hint = is_codex_session_id(thread_id).then(|| thread_id.to_string());
        let session_id = select_external_session_for_runtime(mapped_session_id, hint);
        let cwd = {
            resolve_and_freeze_runtime_cwd(
                &self.thread_manager,
                &thread_id,
                resolve_codex_cwd,
                &message,
                session_id.as_deref(),
                None,
            )
            .await?
        };
        let workspace_paths = message.workspace_paths_for_runtime(AGENT_TYPE);
        let permission_mode = message
            .permission_mode_for_runtime(AGENT_TYPE)
            .map(str::to_string);
        let codex_model = message.codex_model_for_runtime().map(str::to_string);
        let reasoning_effort = message
            .codex_reasoning_effort_for_runtime()
            .map(str::to_string);
        let image_paths = message.image_paths.clone();
        let prompt = message.llm_content.unwrap_or(message.content);
        runtime_log::record_agent_event(
            "info",
            "codex_process",
            "codex.spawn_start",
            "Starting Codex CLI",
            Some(thread_id),
            Some(AGENT_TYPE),
            Some(serde_json::json!({
                "session_mode": if session_id.is_some() { "resume" } else { "new" },
                "session_id": session_id,
                "cwd": cwd.display().to_string(),
                "workspace_paths": workspace_paths,
                "permission_mode": permission_mode,
                "codex_model": codex_model,
                "reasoning_effort": reasoning_effort,
                "image_count": image_paths.len(),
                "prompt_chars": prompt.chars().count(),
            })),
        );
        if diagnostics_enabled() {
            runtime_log::record_agent_event(
                "info",
                "codex_diagnostics",
                "codex.diagnostics",
                "Codex diagnostic snapshot",
                Some(thread_id),
                Some(AGENT_TYPE),
                Some(serde_json::json!({
                    "run_id": run_id,
                    "binary": resolve_codex_binary().display().to_string(),
                    "cwd": cwd.display().to_string(),
                    "workspace_paths": workspace_paths,
                    "permission_mode": permission_mode,
                    "codex_model": codex_model,
                    "reasoning_effort": reasoning_effort,
                    "session_mode": if session_id.is_some() { "resume" } else { "new" },
                    "session_id": session_id,
                })),
            );
        }

        preflight_codex()?;
        let started_at_millis = chrono::Utc::now().timestamp_millis();

        let mut child = build_codex_command_with_images(
            session_id.as_deref(),
            &cwd,
            &workspace_paths,
            permission_mode.as_deref(),
            codex_model.as_deref(),
            reasoning_effort.as_deref(),
            &image_paths,
        )
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start Codex CLI: {e}"))?;
        let child_pid = child.id();
        runtime_log::record_agent_event(
            "info",
            "codex_process",
            "codex.spawn_ok",
            "Codex CLI process started",
            Some(thread_id),
            Some(AGENT_TYPE),
            Some(serde_json::json!({
                "child_pid": child_pid,
            })),
        );

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(prompt.as_bytes())
                .await
                .map_err(|e| format!("failed to write Codex prompt: {e}"))?;
            stdin
                .shutdown()
                .await
                .map_err(|e| format!("failed to close Codex stdin: {e}"))?;
        }

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to capture Codex stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "failed to capture Codex stderr".to_string())?;

        if let Err(mut duplicate_child) = self
            .runs
            .try_insert(
                thread_id.to_string(),
                child,
                Some(run_id.to_string()),
                stream_end_emitted.clone(),
            )
            .await
        {
            let _ = duplicate_child.kill().await;
            return Err("Codex CLI is already running for this thread".to_string());
        }

        let stdout_task = read_codex_stdout(
            thread_id.to_string(),
            run_id.to_string(),
            app_handle.clone(),
            self.thread_manager.clone(),
            self.runs.clone(),
            BufReader::new(stdout),
            stream_end_emitted.clone(),
            started_at_millis,
        );
        let stderr_task =
            read_stderr_to_string(thread_id, Some(run_id), &self.runs, BufReader::new(stderr));

        let (stdout_result, stderr_text) = tokio::join!(stdout_task, stderr_task);
        // stdout reader 排空后返回;只有未正常完成的 turn 才可能执行 rollout
        // 恢复。StreamEnd 统一由 chat_stream 尾部 / stop_chat / watchdog 通过
        // CAS 发送。
        stdout_result?;

        let mut child = self.runs.remove_if_run_id(thread_id, Some(run_id)).await;
        let status = if let Some(running) = child.as_mut() {
            running.child.wait().await.map_err(|e| e.to_string())?
        } else {
            // child 已�? stop_chat �?watchdog 移走 ── 二者都�?CAS 抢发�?
            // StreamEnd, 这里直接返回, tail �?CAS 会失败�?skip, 不双发�?
            runtime_log::record_agent_event(
                "warn",
                "codex_process",
                "codex.child_missing_after_run",
                "Codex child was removed before wait; likely stopped by user or watchdog",
                Some(thread_id),
                Some(AGENT_TYPE),
                Some(serde_json::json!({ "child_pid": child_pid })),
            );
            return Ok(());
        };

        let stderr_text = stderr_text.unwrap_or_default();
        runtime_log::record_agent_event(
            if status.success() { "info" } else { "error" },
            "codex_process",
            "codex.exit",
            "Codex CLI process exited",
            Some(thread_id),
            Some(AGENT_TYPE),
            Some(serde_json::json!({
                "child_pid": child_pid,
                "success": status.success(),
                "code": status.code(),
                "stderr_chars": stderr_text.chars().count(),
                "stderr_preview": truncate_for_log(stderr_text.trim()),
            })),
        );
        if !status.success() {
            return Err(format_codex_failure(&status.to_string(), &stderr_text));
        }
        if !stderr_text.trim().is_empty() {
            tracing::info!("[CodexCli] stderr: {}", stderr_text.trim());
        }
        Ok(())
    }
}

fn format_codex_failure(status: &str, detail: &str) -> String {
    let detail = detail.trim();
    if detail.is_empty() {
        return format!("Codex CLI exited with status {status}");
    }

    let mut message = format!("Codex CLI exited with status {status}: {detail}");
    if detail.contains("Missing optional dependency") {
        message.push_str(concat!(
            " Codex's native platform dependency is missing or was installed for a different ",
            "Node.js architecture. Reinstall with `npm install -g @openai/codex@latest ",
            "--force --include=optional`, or set CODEX_NODE_PATH to a matching Node.js runtime.",
        ));
    }
    message
}

#[cfg(test)]
mod tests;
