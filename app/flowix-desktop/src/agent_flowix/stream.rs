use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures::StreamExt;
use rllm::chat::{ChatRole, MessageType};
use rllm::ToolCall as LlmToolCall;

use crate::agent_external::{emit_chunk_with_run_id, resolve_run_id};
use crate::agent_flowix::providers::{OpenAICompatibleChatMessage, OpenAICompatibleStreamItem};
use crate::runtime_log;

use super::persistence::IsLoadingGuard;
use super::provider::{AgentInstance, AgentTaggedStream};
use super::state::{InFlightChat, STUCK_THRESHOLD};
use super::wire::FLOWIX_AGENT_TYPE;
use super::{AgentChunk, AgentError, AgentManager, AgentUserMessage, UsageInfo};

const MAX_LLM_RECOVERY_RETRIES: u32 = 2;
const MAX_AUTO_RESUME_ATTEMPTS: u32 = 1;

pub(super) trait AgentChunkEmitter: Send + Sync {
    fn emit(&self, chunk: &AgentChunk, run_id: &str);
}

struct TauriAgentChunkEmitter<'a> {
    app_handle: &'a tauri::AppHandle,
}

impl AgentChunkEmitter for TauriAgentChunkEmitter<'_> {
    fn emit(&self, chunk: &AgentChunk, run_id: &str) {
        emit_chunk_with_run_id(self.app_handle, chunk, FLOWIX_AGENT_TYPE, run_id);
    }
}

#[derive(Debug, Clone)]
struct AssistantCheckpoint {
    message_id: String,
    content: String,
}

enum ProviderStreamStart {
    Ready(AgentTaggedStream),
    Finished(String),
}

mod recovery;
#[cfg(test)]
pub(super) use recovery::extract_llm_error_message;
use recovery::{build_recovery_instruction, is_auto_resumable_mid_stream};
pub(super) use recovery::{classify_llm_failure, format_llm_unavailable_message, LlmFailureKind};

impl AgentManager {
    /// Common end-of-cycle exit. Emits the message as a `Text` chunk
    /// (so the frontend appends it to / creates the assistant message via
    /// the `text` case at chat-store.ts:280), persists the same text as
    /// a `role: assistant` row, clears the stuck-detection counter, and
    /// returns `Ok(msg)`. Used by `synthesize_llm_unavailable`, the
    /// `Stuck` abort site, and the `MaxCycles` abort site 鈥?all three
    /// were doing the same shape before this helper existed.
    pub(super) async fn finalize_with_synthesized_message(
        &self,
        thread_id: &str,
        msg: String,
        emitter: &dyn AgentChunkEmitter,
        run_id: &str,
    ) -> Result<String, AgentError> {
        emitter.emit(
            &AgentChunk::Text {
                thread_id: thread_id.to_string(),
                text: msg.clone(),
            },
            run_id,
        );
        self.flush_assistant_message(thread_id, &msg, None).await?;
        self.clear_tool_call_attempts(thread_id).await;
        Ok(msg)
    }

    /// Graceful exit for LLM-side failures. Builds the user-facing
    /// message, logs a warn, and delegates to
    /// `finalize_with_synthesized_message`. Use this for any
    /// `chat_stream_tagged` / mid-stream error path so the chat doesn't
    /// end in a hard error toast.
    pub(super) async fn synthesize_llm_unavailable(
        &self,
        thread_id: &str,
        reason: &str,
        emitter: &dyn AgentChunkEmitter,
        run_id: &str,
    ) -> Result<String, AgentError> {
        let synth_msg = format_llm_unavailable_message(reason);
        tracing::warn!("[Agent] LLM unavailable, synthesizing assistant message: {synth_msg}");
        self.finalize_with_synthesized_message(thread_id, synth_msg, emitter, run_id)
            .await
    }

    async fn checkpoint_stream_buffers(
        &self,
        thread_id: &str,
        reasoning_buffer: &mut String,
        assistant_buffer: &mut String,
        assistant_checkpoint: &mut Option<AssistantCheckpoint>,
    ) -> Result<bool, AgentError> {
        let mut wrote_checkpoint = false;
        if !reasoning_buffer.is_empty() {
            self.flush_reasoning_message(thread_id, reasoning_buffer)
                .await?;
            reasoning_buffer.clear();
            wrote_checkpoint = true;
        }
        if !assistant_buffer.is_empty() {
            if let Some(checkpoint) = assistant_checkpoint.as_mut() {
                checkpoint.content.push_str(assistant_buffer);
                self.update_assistant_checkpoint(
                    thread_id,
                    &checkpoint.message_id,
                    &checkpoint.content,
                    Some(false),
                    None,
                    None,
                )
                .await?;
            } else {
                let message_id = self
                    .flush_assistant_checkpoint(thread_id, assistant_buffer, None)
                    .await?;
                *assistant_checkpoint = Some(AssistantCheckpoint {
                    message_id,
                    content: assistant_buffer.clone(),
                });
            }
            assistant_buffer.clear();
            wrote_checkpoint = true;
        }
        Ok(wrote_checkpoint)
    }

    async fn finalize_mid_stream_unavailable(
        &self,
        thread_id: &str,
        reason: &str,
        reasoning_buffer: &mut String,
        assistant_buffer: &mut String,
        assistant_checkpoint: &mut Option<AssistantCheckpoint>,
        full_response: &str,
        emitter: &dyn AgentChunkEmitter,
        run_id: &str,
    ) -> Result<String, AgentError> {
        let synth_msg = format_llm_unavailable_message(reason);
        if !reasoning_buffer.is_empty() {
            self.flush_reasoning_message(thread_id, reasoning_buffer)
                .await?;
            reasoning_buffer.clear();
        }

        if assistant_checkpoint.is_some() || !assistant_buffer.is_empty() {
            emitter.emit(
                &AgentChunk::Text {
                    thread_id: thread_id.to_string(),
                    text: synth_msg.clone(),
                },
                run_id,
            );

            if let Some(checkpoint) = assistant_checkpoint.as_mut() {
                checkpoint.content.push_str(assistant_buffer);
                checkpoint.content.push_str(&synth_msg);
                assistant_buffer.clear();
                self.update_assistant_checkpoint(
                    thread_id,
                    &checkpoint.message_id,
                    &checkpoint.content,
                    Some(false),
                    None,
                    None,
                )
                .await?;
            } else {
                let final_content = format!("{assistant_buffer}{synth_msg}");
                assistant_buffer.clear();
                let _ = self
                    .flush_assistant_checkpoint(thread_id, &final_content, None)
                    .await?;
            }
            self.clear_tool_call_attempts(thread_id).await;
            return Ok(format!("{full_response}{synth_msg}"));
        }

        self.synthesize_llm_unavailable(thread_id, reason, emitter, run_id)
            .await
    }

    /// Outer entry 鈥?registers a per-thread cancel flag, **spawns** the inner
    /// implementation onto tokio, and immediately returns. The spawned task
    /// owns the cancel-flag lifecycle (insert / remove + emit `StreamStart`
    /// / `StreamEnd`) so every exit path of the inner loop is observable to
    /// the frontend through chunks rather than the IPC return value.
    ///
    /// Background-running model: when a user creates a new conversation
    /// while thread A is still streaming, we **don't** await A's completion.
    /// The IPC returns `Ok("")` immediately and A keeps running in the
    /// background. The frontend's chunk listener dispatches incoming
    /// `agent-chunk` events to `threadStates[tid]`, so re-entering thread A
    /// shows the latest in-progress content. UI state (`isLoading`) is
    /// driven by `StreamStart` / `StreamEnd` chunks rather than the IPC
    /// `finally` block (which would only fire when the **active** thread
    /// finishes).
    ///
    /// **Self-interrupt**: if a chat is already in-flight for this
    /// `thread_id` (e.g. user sent two messages in a row before the first
    /// one finished), the existing cancel flag is `store(true)`'d before
    /// the new one is installed. The old chat's ReAct loop hits a
    /// checkpoint, runs `flush_cancel`, and exits via the normal
    /// StreamEnd path 鈥?guaranteeing at most one in-flight chat per
    /// thread_id at any time, even under user double-click. The old task
    /// only unregisters itself if the registry still points at its own
    /// cancel flag, so it cannot tear down a newer run.
    pub async fn chat_stream(
        self: &Arc<Self>,
        thread_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
    ) -> Result<String, AgentError> {
        let cancel = Arc::new(AtomicBool::new(false));
        let run_id = resolve_run_id(thread_id, message.run_id.as_deref());
        // The user row is business state, not an event journal. Commit it
        // before publishing anything so sibling Webviews can never render a
        // user message that authoritative history cannot return.
        self.persist_user_message(thread_id, &message, &run_id)
            .await?;
        {
            let mut in_flight = self.in_flight.lock().await;
            // �?���? 如果�?thread 已有 in-flight chat, �?set true
            // 让旧 chat 在下一�?checkpoint �?flush_cancel, �?install
            // �?run。旧 task 退出时�?��通过 Arc::ptr_eq 清理�?���?entry,
            // 不会�?���?task �?registry�?
            if let Some(old) = in_flight.remove(thread_id) {
                old.cancel.store(true, Ordering::Release);
                tracing::info!(
                    "[Agent] self-interrupt for thread_id {thread_id} (previous chat in flight)"
                );
            }
            in_flight.insert(
                thread_id.to_string(),
                InFlightChat {
                    cancel: cancel.clone(),
                    started_at: chrono::Utc::now().timestamp_millis(),
                    run_id: run_id.clone(),
                },
            );
        }

        // Publish the product-owned user row before StreamStart, matching the
        // external runtime protocol. The sending Webview already has the same
        // run-scoped id optimistically; sibling Webviews need this event to
        // render the complete turn without waiting for a history reload.
        emit_chunk_with_run_id(
            app_handle,
            &AgentChunk::UserMessage {
                thread_id: thread_id.to_string(),
                id: format!("user-{run_id}"),
                text: message.content.clone(),
                timestamp: chrono::Utc::now().timestamp_millis(),
            },
            FLOWIX_AGENT_TYPE,
            &run_id,
        );

        // 閫氱敤 metadata 鍗忚 鈹€鈹€ StreamStart 鎼哄甫 model / reasoning_effort,
        // �?run 锁定。前�?hover card / 状态栏�??这两�?��段展示�?        // �?provider 不识�?���?None,前�? fallback 到全局配置 / 显示 "—」�?        //
        // `run_id` 閫氳繃 `resolve_run_id` 缁熶竴鏉ユ簮 鈹€鈹€ 鍓嶇浼犲氨鐢ㄥ墠绔殑,
        // 没传�?mint 一�?(�?CLI managers 同形)。这保证每个 chunk 都带
        // run_id, 前�? mapper 不再 fallback �?`st.activeRunId`, self-interrupt
        // 时旧 run �?StreamEnd 不会�??归到�?run�?
        let agent_type = message.agent_type.as_deref().unwrap_or("flowix");
        let model = message.model_for_runtime(agent_type).map(str::to_string);
        let reasoning_effort = message
            .reasoning_effort_for_runtime(agent_type)
            .map(str::to_string);
        emit_chunk_with_run_id(
            app_handle,
            &AgentChunk::StreamStart {
                thread_id: thread_id.to_string(),
                model,
                reasoning_effort,
            },
            FLOWIX_AGENT_TYPE,
            &run_id,
        );

        // spawn �?IPC 立即返回, 不再 await 整个 stream 跑完�?        // 失败 / 完成 / 取消信号全靠 `agent-chunk` 事件 (包括 `Error`
        // �?`StreamEnd`), 前�? store �?thread_id 派发到�?�?thread�?        //
        // `me: Arc<Self>` ── �?self �?Arc clone 一份喂�?spawn task,
        // 任务�?self 之后 (e.g. AppState drop) 才结�? refcount �?��
        // 收敛。这�?��用 self 给异步任务的标准做法, 避免�?struct �?        // �?Weak<Self> 那�?�?��引用�?
        let me: Arc<AgentManager> = Arc::clone(self);
        let tid_owned = thread_id.to_string();
        let app_handle_owned = app_handle.clone();
        let cancel_for_task = cancel.clone();
        let run_id_owned = run_id.clone();
        tokio::spawn(async move {
            let result = me
                .chat_stream_inner(
                    &tid_owned,
                    message,
                    &app_handle_owned,
                    &cancel_for_task,
                    run_id_owned.clone(),
                )
                .await;

            // 任何�?��退出都�?unregister + emit StreamEnd。任务结束前
            // 先清 in_flight, 最�?emit ── 前�?收到 StreamEnd �? 我们
            // �?in-memory 状态已经归�? 任何
            // 立即触发�?`agent_running_threads` 查�?都看不到这个 thread
            // (�?stream 真结束了"的�?义一�?�?
            me.unregister_in_flight_if_current(&tid_owned, &cancel_for_task)
                .await;
            let reason = match &result {
                Ok(_) => None,
                Err(e) => Some(e.to_string()),
            };
            emit_chunk_with_run_id(
                &app_handle_owned,
                &AgentChunk::StreamEnd {
                    thread_id: tid_owned.clone(),
                    reason,
                },
                FLOWIX_AGENT_TYPE,
                &run_id_owned,
            );
        });

        Ok(String::new())
    }

    /// Inner implementation 鈥?the actual ReAct loop with three cancel
    /// checkpoints. Does NOT touch `in_flight` directly; the outer
    /// `chat_stream` owns registration lifecycle.
    ///
    /// Cancel checkpoints:
    ///   #1. Top of `for _cycle` 鈥?between cycles, before reload. Catches
    ///       "user clicked stop right after a tool-call cycle's flush".
    ///   #2. Top of `while let Some(item) = stream.next().await` 鈥?mid-
    ///       stream. Returning here drops `stream` and aborts the HTTP
    ///       connection.
    ///   #3. After the inner while loop 鈥?after stream is exhausted,
    ///       before the final-return or next-cycle decision. Catches
    ///       "user clicked stop right after the last chunk arrived".
    ///
    /// All three sites funnel into `flush_cancel`, which mirrors the
    /// existing `finalize_with_synthesized_message` shape (flush partial
    /// buffers, emit a final chunk, clear tool-call attempts) but with
    /// the user-cancellation message instead of an LLM-unavailable one.
    pub(super) async fn chat_stream_inner(
        &self,
        thread_id: &str,
        message: AgentUserMessage,
        app_handle: &tauri::AppHandle,
        cancel: &Arc<AtomicBool>,
        run_id: String,
    ) -> Result<String, AgentError> {
        let mut ai_config = self.user_config.get_ai_config().model;
        let agent_type = message.agent_type.as_deref().unwrap_or("flowix");
        if let Some(model) = message.model_for_runtime(agent_type) {
            if !model.trim().is_empty() {
                ai_config.model = model.to_string();
            }
        }
        let instance = if let Some(role_section) = self.agent_role_system_section(&message) {
            // Runtime Agent Role takes the role slot 鈥?base_system_prompt
            // omits the default static role section in this branch, keeping
            // exactly one role block in the final prompt (mutual exclusion
            // with [`crate::agent_flowix::prompt::role::section`]).
            let system_prompt = self.base_system_prompt(&ai_config, Some(&role_section));
            self.build_instance_with_system_prompt(&ai_config, system_prompt)?
        } else {
            self.ensure_instance(&ai_config).await?
        };

        let emitter = TauriAgentChunkEmitter { app_handle };
        self.run_react_loop(thread_id, message, instance, &emitter, cancel, run_id)
            .await
    }

    async fn open_provider_stream_with_recovery(
        &self,
        instance: &AgentInstance,
        thread_id: &str,
        llm_messages: &mut Vec<OpenAICompatibleChatMessage>,
        emitter: &dyn AgentChunkEmitter,
        run_id: &str,
    ) -> Result<ProviderStreamStart, AgentError> {
        let mut recovery_attempts: u32 = 0;
        loop {
            match instance
                .provider
                .chat_stream_tagged(llm_messages, Some(&instance.tools))
                .await
            {
                Ok(stream) => return Ok(ProviderStreamStart::Ready(stream)),
                Err(error) => {
                    let reason = error.to_string();
                    let failure_kind = classify_llm_failure(&reason);
                    let can_retry = recovery_attempts < MAX_LLM_RECOVERY_RETRIES
                        && failure_kind == LlmFailureKind::RecoverableHistory;
                    if !can_retry {
                        runtime_log::record_agent_event(
                            "error",
                            "llm_stream",
                            "llm.stream_failed",
                            format!("LLM stream request failed: {error}"),
                            Some(thread_id),
                            None,
                            Some(serde_json::json!({
                                "failure_kind": format!("{failure_kind:?}"),
                                "is_recoverable_args_error": failure_kind == LlmFailureKind::RecoverableHistory,
                                "recovery_attempts": recovery_attempts,
                            })),
                        );
                        let message = self
                            .synthesize_llm_unavailable(
                                thread_id,
                                &format!("Stream failed: {error}"),
                                emitter,
                                run_id,
                            )
                            .await?;
                        return Ok(ProviderStreamStart::Finished(message));
                    }

                    match self.sanitize_persisted_tool_calls(thread_id).await {
                        Ok(true) => {
                            recovery_attempts += 1;
                            let progress = format!(
                                "LLM rejected turn due to malformed tool_calls; \
                                 sanitized and retrying ({recovery_attempts}/{MAX_LLM_RECOVERY_RETRIES})"
                            );
                            tracing::warn!("[Agent] {progress}");
                            runtime_log::record_agent_event(
                                "warn",
                                "recovery_retry",
                                "llm.sanitize_retry",
                                progress.clone(),
                                Some(thread_id),
                                None,
                                Some(serde_json::json!({
                                    "recovery_attempts": recovery_attempts,
                                    "max_recovery_attempts": MAX_LLM_RECOVERY_RETRIES,
                                })),
                            );
                            emitter.emit(
                                &AgentChunk::Error {
                                    thread_id: thread_id.to_string(),
                                    message: progress,
                                },
                                run_id,
                            );
                            *llm_messages = self.load_thread_llm_messages(thread_id).await?;
                        }
                        Ok(false) | Err(_) => {
                            runtime_log::record_agent_event(
                                "error",
                                "llm_stream",
                                "llm.stream_failed",
                                format!("LLM stream request failed: {error}"),
                                Some(thread_id),
                                None,
                                Some(serde_json::json!({
                                    "is_recoverable_args_error": true,
                                    "sanitize_attempted": true,
                                    "sanitize_result": "no_change_or_failed",
                                    "recovery_attempts": recovery_attempts,
                                })),
                            );
                            let message = self
                                .synthesize_llm_unavailable(
                                    thread_id,
                                    &format!("Stream failed: {error}"),
                                    emitter,
                                    run_id,
                                )
                                .await?;
                            return Ok(ProviderStreamStart::Finished(message));
                        }
                    }
                }
            }
        }
    }

    async fn handle_usage_item(
        &self,
        thread_id: &str,
        usage: UsageInfo,
        total_tokens: u32,
        token_budget: u32,
        tokens_used: &mut u32,
        emitter: &dyn AgentChunkEmitter,
        run_id: &str,
    ) -> Result<Option<String>, AgentError> {
        emitter.emit(
            &AgentChunk::Usage {
                thread_id: thread_id.to_string(),
                model_id: None,
                last_run_at: None,
                usage: Some(usage),
                status_info: None,
            },
            run_id,
        );
        *tokens_used = tokens_used.saturating_add(total_tokens);
        if token_budget == 0 || *tokens_used <= token_budget {
            return Ok(None);
        }

        let error = AgentError::TokenBudget {
            used: *tokens_used,
            budget: token_budget,
        };
        let error_message = error.to_string();
        tracing::warn!("[Agent] {error_message}");
        runtime_log::record_agent_event(
            "warn",
            "token_budget",
            "llm.token_budget_exceeded",
            error_message.clone(),
            Some(thread_id),
            None,
            Some(serde_json::json!({
                "tokens_used": *tokens_used,
                "token_budget": token_budget,
            })),
        );
        emitter.emit(
            &AgentChunk::Error {
                thread_id: thread_id.to_string(),
                message: error_message.clone(),
            },
            run_id,
        );
        let message = self
            .finalize_with_synthesized_message(
                thread_id,
                format!(
                    "(agent aborted — {error_message}). Split the request into smaller pieces \
                     or raise `max_total_tokens` in Preferences → Agent."
                ),
                emitter,
                run_id,
            )
            .await?;
        Ok(Some(message))
    }

    async fn handle_tool_call_item(
        &self,
        thread_id: &str,
        tool_call: LlmToolCall,
        message: &AgentUserMessage,
        reasoning_buffer: &mut String,
        assistant_buffer: &mut String,
        assistant_checkpoint: &mut Option<AssistantCheckpoint>,
        last_tool_name: &mut Option<String>,
        emitter: &dyn AgentChunkEmitter,
        run_id: &str,
    ) -> Result<Option<String>, AgentError> {
        let reasoning_for_turn = if reasoning_buffer.trim().is_empty() {
            None
        } else {
            Some(reasoning_buffer.clone())
        };
        self.flush_reasoning_message(thread_id, reasoning_buffer)
            .await?;
        reasoning_buffer.clear();

        if let Some(mut checkpoint) = assistant_checkpoint.take() {
            checkpoint.content.push_str(assistant_buffer);
            self.update_assistant_checkpoint(
                thread_id,
                &checkpoint.message_id,
                &checkpoint.content,
                Some(true),
                Some(std::slice::from_ref(&tool_call)),
                reasoning_for_turn.as_deref(),
            )
            .await?;
        } else {
            self.flush_assistant_message_with_tool_calls(
                thread_id,
                assistant_buffer,
                std::slice::from_ref(&tool_call),
                reasoning_for_turn.as_deref(),
            )
            .await?;
        }
        assistant_buffer.clear();

        let tool_input = match serde_json::from_str::<serde_json::Value>(
            &tool_call.function.arguments,
        ) {
            Ok(value) => value,
            Err(error) => {
                tracing::warn!(
                    "[Agent] tool_call {} ({}): arguments not valid JSON ({error}); falling back to {{}}",
                    tool_call.id,
                    tool_call.function.name
                );
                serde_json::Value::Object(serde_json::Map::new())
            }
        };
        emitter.emit(
            &AgentChunk::ToolCall {
                thread_id: thread_id.to_string(),
                id: tool_call.id.clone(),
                name: tool_call.function.name.clone(),
                input: tool_input.clone(),
            },
            run_id,
        );
        self.persist_tool_call(
            thread_id,
            &tool_call.id,
            &tool_call.function.name,
            tool_input,
        )
        .await?;

        let _loading_guard =
            IsLoadingGuard::new(self.thread_manager.clone(), thread_id, &tool_call.id);
        let tool_result = self
            .execute_tool_for_thread(
                thread_id,
                &tool_call.function.name,
                &tool_call.function.arguments,
                message,
            )
            .await;
        emitter.emit(
            &AgentChunk::ToolResult {
                thread_id: thread_id.to_string(),
                id: tool_call.id.clone(),
                name: tool_call.function.name.clone(),
                result: serde_json::to_value(&tool_result).unwrap_or(serde_json::Value::Null),
            },
            run_id,
        );
        let result_json = serde_json::to_string_pretty(&tool_result)
            .unwrap_or_else(|_| r#"{"error":"serialization failed"}"#.to_string());
        self.persist_tool_result(
            thread_id,
            &tool_call.id,
            &tool_call.function.name,
            &result_json,
        )
        .await?;

        *last_tool_name = Some(tool_call.function.name.clone());
        let stuck = self
            .record_tool_call(
                thread_id,
                &tool_call.function.name,
                &tool_call.function.arguments,
            )
            .await;
        if !stuck {
            return Ok(None);
        }

        let error = AgentError::Stuck {
            tool: tool_call.function.name.clone(),
            count: STUCK_THRESHOLD + 1,
        };
        let error_message = error.to_string();
        tracing::warn!("[Agent] {error_message}");
        runtime_log::record_agent_event(
            "warn",
            "stuck",
            "agent.stuck",
            error_message.clone(),
            Some(thread_id),
            Some(&tool_call.function.name),
            Some(serde_json::json!({
                "count": STUCK_THRESHOLD + 1,
                "threshold": STUCK_THRESHOLD,
            })),
        );
        let message = self
            .finalize_with_synthesized_message(
                thread_id,
                format!(
                    "(agent aborted — {error_message}). Try rephrasing the request \
                     or check that the file path is correct."
                ),
                emitter,
                run_id,
            )
            .await?;
        Ok(Some(message))
    }

    /// ReAct state machine with provider and event output injected. Keeping
    /// configuration/provider construction outside makes the transition logic
    /// testable with scripted streams and a recording emitter.
    pub(super) async fn run_react_loop(
        &self,
        thread_id: &str,
        message: AgentUserMessage,
        instance: AgentInstance,
        emitter: &dyn AgentChunkEmitter,
        cancel: &Arc<AtomicBool>,
        run_id: String,
    ) -> Result<String, AgentError> {
        // 兜底清空�?thread 的卡死�?测�?数。LLM 给最终回答的正常�?��也会�?
        // A user retry starts a fresh stuck-tool detection window.
        self.clear_tool_call_attempts(thread_id).await;
        // 用户消息已落�? 下面�?ReAct �?���?���?reload 会�?到�?        // load_thread_llm_messages 现在直接返回 rllm �?ChatMessage 序列, 包含
        // tool_use / tool_result。每�?cycle 顶部�?reload 一次拿到最新落盘状态�?
        // React loop with streaming
        let max_cycles = 100;
        let mut full_response = String::new();
        let mut reasoning_buffer = String::new();
        let mut assistant_buffer = String::new();
        let mut assistant_checkpoint: Option<AssistantCheckpoint> = None;
        let mut pending_recovery_instruction: Option<String> = None;
        let mut auto_resume_attempts: u32 = 0;
        // Tracked across cycles so the MaxCycles error message can name
        // the last tool the LLM was stuck on.
        let mut last_tool_name: Option<String> = None;

        // ── Token 预算: �?cycle �?? total_tokens, 超过配置上限立刻熔断。──
        // budget=0 表示不限 (�?config 行为, 也方便单�?。Usage chunk �?        // provider 在每�?���?��单独 push 一�? 不会重�?计数 ── 这是�?        // 之前 "Usage 解析后完全没�? 的�?字�?�?provider 层穿透出来的�?���?        // 注意: OpenAI �?`prompt_tokens` �?stream+include_usage 模式下是
        // **�??**�?(整个 thread 的输�?, 不是单轮 ── 我们的累计是有意为之�?
        let token_budget = self.user_config.get_ai_config().model.max_total_tokens;
        let mut tokens_used: u32 = 0;

        tracing::debug!("[Agent] Starting chat_stream for thread_id: {}", thread_id);

        'cycle_loop: for _cycle in 0..max_cycles {
            // 鈹€鈹€ Checkpoint #1: between cycles, before reload. 鈹€鈹€
            if cancel.load(Ordering::Acquire) {
                return self
                    .flush_cancel(
                        thread_id,
                        reasoning_buffer,
                        assistant_buffer,
                        full_response,
                        emitter,
                        &run_id,
                    )
                    .await;
            }

            // 每轮从盘�?reload, 拿到�?�� (�?���? 新落盘的 assistant(tool_calls) +
            // tool(result) �? 作为下轮 LLM 调用的真实上下文。这�?disk �?��一真源,
            // The persisted thread is the source of truth for user,
            // assistant tool-call, and tool-result messages.
            // Keep the declaration at the point of reload. If this statement
            // is accidentally swallowed by a comment again, later uses fail
            // to compile instead of silently sending a system-only request.
            let mut llm_messages = self.load_thread_llm_messages(thread_id).await?;
            if let Some(instruction) = pending_recovery_instruction.take() {
                llm_messages.push(OpenAICompatibleChatMessage {
                    role: ChatRole::User,
                    content: instruction,
                    message_type: MessageType::Text,
                    reasoning: None,
                });
            }
            reasoning_buffer.clear();
            assistant_buffer.clear();
            let mut hit_tool_call = false;
            let mut stream = match self
                .open_provider_stream_with_recovery(
                    &instance,
                    thread_id,
                    &mut llm_messages,
                    emitter,
                    &run_id,
                )
                .await?
            {
                ProviderStreamStart::Ready(stream) => stream,
                ProviderStreamStart::Finished(message) => return Ok(message),
            };

            // Process stream items —OpenAICompatibleStreamItem 区分 reasoning vs text,
            // 直接发结构化 AgentChunk 给前�? �?switch �?��而非 startsWith�?
            while let Some(item_result) = stream.next().await {
                // 鈹€鈹€ Checkpoint #2: mid-stream, before each poll. 鈹€鈹€
                // Returning here drops `stream`, which aborts the in-flight
                // HTTP connection (reqwest's `bytes_stream` semantics).
                if cancel.load(Ordering::Acquire) {
                    return self
                        .flush_cancel(
                            thread_id,
                            reasoning_buffer,
                            assistant_buffer,
                            full_response,
                            emitter,
                            &run_id,
                        )
                        .await;
                }
                match item_result {
                    Ok(item) => {
                        match item {
                            OpenAICompatibleStreamItem::Usage {
                                total_tokens,
                                input_tokens,
                                cached_input_tokens,
                                output_tokens,
                                reasoning_output_tokens,
                                model_context_window,
                            } => {
                                let usage = UsageInfo {
                                    input_tokens,
                                    cached_input_tokens,
                                    output_tokens,
                                    reasoning_output_tokens,
                                    total_tokens: Some(total_tokens),
                                    model_context_window,
                                };
                                if let Some(message) = self
                                    .handle_usage_item(
                                        thread_id,
                                        usage,
                                        total_tokens,
                                        token_budget,
                                        &mut tokens_used,
                                        emitter,
                                        &run_id,
                                    )
                                    .await?
                                {
                                    return Ok(message);
                                }
                            }
                            OpenAICompatibleStreamItem::Text(text) => {
                                tracing::debug!("[Agent] Emitting text chunk: {}", text);
                                emitter.emit(
                                    &AgentChunk::Text {
                                        thread_id: thread_id.to_string(),
                                        text: text.clone(),
                                    },
                                    &run_id,
                                );
                                assistant_buffer.push_str(&text);
                                full_response.push_str(&text);
                            }
                            OpenAICompatibleStreamItem::Reasoning(text) => {
                                tracing::debug!("[Agent] Emitting reasoning chunk: {}", text);
                                emitter.emit(
                                    &AgentChunk::Reasoning {
                                        thread_id: thread_id.to_string(),
                                        text: text.clone(),
                                    },
                                    &run_id,
                                );
                                reasoning_buffer.push_str(&text);
                            }
                            OpenAICompatibleStreamItem::ToolUseComplete { tool_call } => {
                                if let Some(message) = self
                                    .handle_tool_call_item(
                                        thread_id,
                                        tool_call,
                                        &message,
                                        &mut reasoning_buffer,
                                        &mut assistant_buffer,
                                        &mut assistant_checkpoint,
                                        &mut last_tool_name,
                                        emitter,
                                        &run_id,
                                    )
                                    .await?
                                {
                                    return Ok(message);
                                }
                                hit_tool_call = true;
                                break;
                            }
                            OpenAICompatibleStreamItem::Done { .. } => {
                                // Stream ended —no-op, �?���?��退�?
                            }
                        }
                    }
                    Err(e) => {
                        // Mid-stream failure (network blip, provider 5xx,
                        // socket close, etc.). The tool_use/tool_result
                        // for this cycle are already persisted (see the
                        // ToolUseComplete arm), so the thread state is
                        // consistent; we just need to end the cycle.
                        // Synthesize an assistant message and return Ok.
                        // 与初�?request 失败不同, 这条�?��到一半断�?──
                        // 閮ㄥ垎 tokens 宸茬粡鑺卞湪 reasoning / text / 宸ュ叿
                        // 调用�? 用户重发时会接着上�?的中�?��继续
                        // (thread.db �?���?�?错�?�?��仍然�?LLM
                        // 不可�? 走同一�?synthesize �?��, 但日志上
                        // kind �?`llm_stream_mid` 区分前后�?
                        runtime_log::record_agent_event(
                            "error",
                            "llm_stream_mid",
                            "llm.stream_mid_error",
                            format!("LLM stream errored mid-flight: {e}"),
                            Some(thread_id),
                            None,
                            None,
                        );
                        let reason = format!("Stream error: {}", e);
                        let failure_kind = classify_llm_failure(&reason);
                        if is_auto_resumable_mid_stream(failure_kind)
                            && auto_resume_attempts < MAX_AUTO_RESUME_ATTEMPTS
                        {
                            auto_resume_attempts += 1;
                            let wrote_checkpoint = self
                                .checkpoint_stream_buffers(
                                    thread_id,
                                    &mut reasoning_buffer,
                                    &mut assistant_buffer,
                                    &mut assistant_checkpoint,
                                )
                                .await?;
                            let instruction = build_recovery_instruction(&reason);
                            pending_recovery_instruction = Some(instruction);
                            let progress = format!(
                                "recovering interrupted LLM stream ({auto_resume_attempts}/{MAX_AUTO_RESUME_ATTEMPTS}); checkpointed_partial={wrote_checkpoint}; kind={failure_kind:?}"
                            );
                            tracing::warn!("[Agent] {progress}");
                            runtime_log::record_agent_event(
                                "warn",
                                "llm_stream_recovery",
                                "llm.stream_auto_resume",
                                progress,
                                Some(thread_id),
                                None,
                                Some(serde_json::json!({
                                    "failure_kind": format!("{failure_kind:?}"),
                                    "auto_resume_attempts": auto_resume_attempts,
                                    "max_auto_resume_attempts": MAX_AUTO_RESUME_ATTEMPTS,
                                    "checkpointed_partial": wrote_checkpoint,
                                })),
                            );
                            continue 'cycle_loop;
                        }

                        return self
                            .finalize_mid_stream_unavailable(
                                thread_id,
                                &reason,
                                &mut reasoning_buffer,
                                &mut assistant_buffer,
                                &mut assistant_checkpoint,
                                &full_response,
                                emitter,
                                &run_id,
                            )
                            .await;
                    }
                }
            }

            // 鈹€鈹€ Checkpoint #3: after stream exhausted, before the
            //    final-return vs. next-cycle decision. 鈹€鈹€ Returning
            //    here drops `stream` cleanly (no more items, but the
            //    connection is still alive at the provider).
            if cancel.load(Ordering::Acquire) {
                return self
                    .flush_cancel(
                        thread_id,
                        reasoning_buffer,
                        assistant_buffer,
                        full_response,
                        emitter,
                        &run_id,
                    )
                    .await;
            }

            // Continue only when this cycle actually executed a tool. A cycle without
            // tool calls is the completion signal for the current ReAct task.
            if !hit_tool_call {
                // A final answer completes the task and clears stuck-tool state.
                self.clear_tool_call_attempts(thread_id).await;
                self.flush_reasoning_message(thread_id, &reasoning_buffer)
                    .await?;
                if let Some(mut checkpoint) = assistant_checkpoint.take() {
                    checkpoint.content.push_str(&assistant_buffer);
                    self.update_assistant_checkpoint(
                        thread_id,
                        &checkpoint.message_id,
                        &checkpoint.content,
                        Some(true),
                        None,
                        Some(&reasoning_buffer),
                    )
                    .await?;
                } else {
                    self.flush_assistant_message(
                        thread_id,
                        &assistant_buffer,
                        Some(&reasoning_buffer),
                    )
                    .await?;
                }
                return Ok(full_response);
            }
        }

        // �?��跑满 max_cycles 还没 return, 说明 LLM 一直在调工具没给最终回答�?        // 合成一条最终的 assistant 消息落盘�?emit, 让用户看到�?常结束而不�?        // "agent crashed" 弹窗, 然后返回 Ok�?
        let last_tool = last_tool_name
            .as_deref()
            .map(|n| format!(" Last tool: `{}`.", n))
            .unwrap_or_default();
        let synth_msg = format!(
            "(agent aborted after {max_cycles} tool-call cycles without a final answer).{last_tool} \
             Try a more specific prompt."
        );
        tracing::warn!("[Agent] agent exceeded max cycles ({max_cycles})");
        // 持久�?max-cycles 熔断 ── `last_tool` 一起写, 配合 thread.db
        // 里的 tool_calls 链能复盘 LLM 为什�?一直调工具不收�?�?
        runtime_log::record_agent_event(
            "warn",
            "max_cycles",
            "agent.max_cycles",
            format!("agent exceeded max cycles ({max_cycles})"),
            Some(thread_id),
            last_tool_name.as_deref(),
            Some(serde_json::json!({
                "max_cycles": max_cycles,
            })),
        );
        return self
            .finalize_with_synthesized_message(thread_id, synth_msg, emitter, &run_id)
            .await;
    }

    /// 取消 helper —`chat_stream_inner` 三个 cancel 站点共用的退出形状�?    /// �?`finalize_with_synthesized_message` 对称, 但用「用户主动停�?��的
    /// 文�? (`_(已停止生�?_`), 不用 LLM 不可用的模板�?    ///
    /// �?suffix 拼到 `assistant_buffer` �?���?`flush_assistant_message`
    /// 落盘, 同时 emit 一�?��立的 `Text` chunk 给前�?(UI 把它当普�?text
    /// 追加, 跟用户看到的实时流体验一�?── 不再需要新事件类型)�?
    pub(super) async fn flush_cancel(
        &self,
        thread_id: &str,
        reasoning_buffer: String,
        assistant_buffer: String,
        full_response: String,
        emitter: &dyn AgentChunkEmitter,
        run_id: &str,
    ) -> Result<String, AgentError> {
        const STOPPED_SUFFIX: &str = "_(已停止生�?_";
        tracing::info!(
            "[Agent] chat cancelled by user for thread_id: {}",
            thread_id
        );
        // 推理模型会先 reasoning �?text, �?��时�?保留思考痕迹�?
        if !reasoning_buffer.is_empty() {
            self.flush_reasoning_message(thread_id, &reasoning_buffer)
                .await?;
        }
        // 落盘最�?assistant �?= 原流式累�?+ 停�?标�?; 同一�?emit �?UI�?
        let final_assistant = format!("{assistant_buffer}{STOPPED_SUFFIX}");
        emitter.emit(
            &AgentChunk::Text {
                thread_id: thread_id.to_string(),
                text: STOPPED_SUFFIX.to_string(),
            },
            run_id,
        );
        // 始终落一�?(�?�?assistant_buffer 为空), �?thread 里有明��?        // 助手结束标�?; `flush_assistant_message` �?���?is_empty �?��,
        // 但我�?��里传的是�?suffix 的非空串, 一定落盘�?
        self.flush_assistant_message(thread_id, &final_assistant, None)
            .await?;
        self.clear_tool_call_attempts(thread_id).await;
        Ok(format!("{full_response}{STOPPED_SUFFIX}"))
    }
}
