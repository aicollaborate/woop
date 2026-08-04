use std::sync::Arc;

use rllm::ToolCall as LlmToolCall;
use uuid::Uuid;

use crate::agent_flowix::providers::OpenAICompatibleChatMessage;
use crate::agent_session::{ChatMessage as ThreadChatMessage, MessageRole, ThreadManager};

use super::context::build_llm_context_window;
use super::{AgentError, AgentManager, AgentUserMessage};

/// RAII guard ── �?`persist_tool_call` (�?`is_loading = true`) 之后,
/// `persist_tool_result` (�?`is_loading = 0`) 之前的任�?panic / early
/// return / 新�?错�?�?��都会触发 drop, fire-and-forget 一�?/// `clear_tool_loading` 把�?应�?解锁, 避免前�?工具调用行永远转圈�?///
/// 解决 #3.1: 历史�?`execute_tool_for_thread` panic 或新增错�?��径�?�?/// `persist_tool_result` 不到�? loading 状态卡死。Success �?���?/// `persist_tool_result` 已经�?is_loading 归零, guard �?drop UPDATE 命中
/// 同一行再�?0 ── 幂等, 不算�?��。Guard �?��不持�?(不持 thread_manager
/// �?read guard), 避免与�?�?RwLock 锁顺序冲突�?
pub(super) struct IsLoadingGuard {
    thread_manager: Arc<ThreadManager>,
    thread_id: String,
    tool_call_id: String,
}

impl IsLoadingGuard {
    pub(super) fn new(
        thread_manager: Arc<ThreadManager>,
        thread_id: &str,
        tool_call_id: &str,
    ) -> Self {
        Self {
            thread_manager,
            thread_id: thread_id.to_string(),
            tool_call_id: tool_call_id.to_string(),
        }
    }
}

impl Drop for IsLoadingGuard {
    fn drop(&mut self) {
        // drop �?��步的, 不能 .await ── 但能 spawn 一�?�� task。task �?        // `thread_manager` �?Arc, 即使 AgentManager 后续�?drop 引用计数
        // 仍能撑住这个 UPDATE 完成�?
        let tm = self.thread_manager.clone();
        let tid = std::mem::take(&mut self.thread_id);
        let tcid = std::mem::take(&mut self.tool_call_id);
        tokio::spawn(async move {
            if let Err(e) = tm.clear_tool_loading(&tid, &tcid).await {
                tracing::warn!("[Agent] IsLoadingGuard reset failed for tool_call {tcid}: {e}");
            }
        });
    }
}

/// 计算 `tool` 行写�?SQLite 时的主键 id ── 抽出来便于单�? 同时也是
/// `persist_tool_call` 的唯一入口, 防�?"两�? format 各自演化"漂移�?///
/// LLM 偶发不给 `tool_call.id`(极少�?gateway / 模型在并行工具调用场�?��漏填),
/// 直接 `format!("tool_{}", "")` 会得�?`"tool_"`, �?thread 内�?�?tool_call
/// 全撞 PRIMARY KEY (`thread_messages.id` �?TEXT PRIMARY KEY, �?`threads.rs`)�?/// 兜底�?UUID v4, 保证每�?调用都得到不�?id�?
pub(super) fn tool_call_row_id(tool_call_id: &str) -> String {
    if tool_call_id.is_empty() {
        format!("tool_{}", Uuid::new_v4())
    } else {
        format!("tool_{}", tool_call_id)
    }
}

pub(super) fn serialize_tool_calls(calls: &[LlmToolCall]) -> serde_json::Value {
    serde_json::Value::Array(
        calls
            .iter()
            .map(|c| {
                serde_json::json!({
                    "id": c.id,
                    "type": c.call_type,
                    "function": {
                        "name": c.function.name,
                        "arguments": c.function.arguments,
                    }
                })
            })
            .collect(),
    )
}

impl AgentManager {
    /// Find the most recent `assistant` message with `tool_calls` and
    /// replace any unparseable `function.arguments` string with `"{}"`.
    /// Returns `Ok(true)` if any row was rewritten, `Ok(false)` otherwise.
    ///
    /// Recovery for the LLM-side 400 "invalid function arguments" rejection.
    /// The root cause is the parallel-call parser collision in
    /// `openai_compatible.rs` 鈥?fixed separately 鈥?but this is the safety
    /// net: degrade gracefully (LLM sees empty args on the next round) rather
    /// than abort the user's session.
    ///
    /// Touches `tool_calls[*].function.arguments` (the wire-format string
    /// the gateway validates), NOT `tool_input` (a UI cache).
    pub(super) async fn sanitize_persisted_tool_calls(
        &self,
        thread_id: &str,
    ) -> Result<bool, AgentError> {
        let manager = &self.thread_manager;
        let mut thread = match manager.get_thread(thread_id).await? {
            Some(t) => t,
            None => return Ok(false),
        };
        // Walk from the end 鈥?the most recent assistant(tool_calls) is
        // the one the gateway is choking on.
        let target = thread
            .messages
            .iter_mut()
            .rev()
            .find(|m| m.role == MessageRole::Assistant.as_str() && m.tool_calls.is_some());
        let Some(target) = target else {
            return Ok(false);
        };
        let Some(serde_json::Value::Array(arr)) = target.tool_calls.as_mut() else {
            return Ok(false);
        };
        let mut dirty = false;
        let mut sanitized_count = 0usize;
        for call in arr.iter_mut() {
            let args_str = call
                .get_mut("function")
                .and_then(|f| f.get_mut("arguments"))
                .and_then(|a| a.as_str())
                .map(|s| s.to_string());
            if let Some(args_str) = args_str {
                if serde_json::from_str::<serde_json::Value>(&args_str).is_err() {
                    tracing::warn!(
                        "[Agent] sanitizing invalid tool_call arguments in message {}",
                        target.id
                    );
                    call["function"]["arguments"] = serde_json::Value::String("{}".to_string());
                    dirty = true;
                    sanitized_count += 1;
                }
            }
        }
        if dirty {
            manager
                .update_message_tool_calls(
                    thread_id,
                    &target.id,
                    &target.tool_calls.clone().unwrap_or(serde_json::Value::Null),
                )
                .await?;
            tracing::info!(
                "[Agent] sanitized {} tool_call(s) in message {}",
                sanitized_count,
                target.id
            );
        }
        Ok(dirty)
    }

    pub(super) async fn persist_user_message(
        &self,
        thread_id: &str,
        message: &AgentUserMessage,
        run_id: &str,
    ) -> Result<(), AgentError> {
        let thread_message = ThreadChatMessage {
            // The frontend creates the same id for its optimistic row. Keeping
            // the durable row run-scoped makes the broadcast idempotent in the
            // originating Webview while sibling Webviews can insert it live.
            id: format!("user-{run_id}"),
            role: MessageRole::User.as_str().to_string(),
            content: message
                .llm_content
                .clone()
                .unwrap_or_else(|| message.content.clone()),
            llm_content: message.llm_content.clone(),
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
        };
        self.add_thread_message(thread_id, thread_message).await
    }

    pub(super) async fn load_thread_llm_messages(
        &self,
        thread_id: &str,
    ) -> Result<Vec<OpenAICompatibleChatMessage>, AgentError> {
        let thread = self
            .thread_manager
            .get_thread(thread_id)
            .await?
            .ok_or_else(|| crate::agent_session::ThreadError::NotFound(thread_id.to_string()))?;
        Ok(build_llm_context_window(thread.messages))
    }

    pub(super) async fn add_thread_message(
        &self,
        thread_id: &str,
        message: ThreadChatMessage,
    ) -> Result<(), AgentError> {
        self.thread_manager.add_message(thread_id, message).await?;
        Ok(())
    }

    pub(super) async fn flush_reasoning_message(
        &self,
        thread_id: &str,
        content: &str,
    ) -> Result<(), AgentError> {
        if content.is_empty() {
            return Ok(());
        }
        self.add_thread_message(
            thread_id,
            ThreadChatMessage {
                id: format!("reasoning_{}", Uuid::new_v4()),
                role: MessageRole::Reasoning.as_str().to_string(),
                content: content.to_string(),
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
    }

    pub(super) async fn flush_assistant_message(
        &self,
        thread_id: &str,
        content: &str,
        reasoning: Option<&str>,
    ) -> Result<(), AgentError> {
        if content.is_empty() {
            return Ok(());
        }
        self.add_thread_message(
            thread_id,
            ThreadChatMessage {
                id: format!("assistant_{}", Uuid::new_v4()),
                role: MessageRole::Assistant.as_str().to_string(),
                content: content.to_string(),
                llm_content: None,
                system_reminder_directory: None,
                timestamp: chrono::Utc::now().to_rfc3339(),
                is_loading: None,
                tool_call_id: None,
                tool_name: None,
                tool_data: None,
                tool_input: None,
                tool_calls: None,
                reasoning: reasoning
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_string),
                is_completed: None,
                is_collapsed: None,
            },
        )
        .await
    }

    /// Persist a partial assistant response after a recoverable stream
    /// failure. The row is intentionally marked `is_completed = false` so
    /// future recovery/UI code can distinguish it from a normal final answer.
    /// The returned id lets the resumed stream append/promote the same row
    /// instead of creating duplicate assistant messages in SQLite.
    pub(super) async fn flush_assistant_checkpoint(
        &self,
        thread_id: &str,
        content: &str,
        reasoning: Option<&str>,
    ) -> Result<String, AgentError> {
        let id = format!("assistant_partial_{}", Uuid::new_v4());
        self.add_thread_message(
            thread_id,
            ThreadChatMessage {
                id: id.clone(),
                role: MessageRole::Assistant.as_str().to_string(),
                content: content.to_string(),
                llm_content: None,
                system_reminder_directory: None,
                timestamp: chrono::Utc::now().to_rfc3339(),
                is_loading: None,
                tool_call_id: None,
                tool_name: None,
                tool_data: None,
                tool_input: None,
                tool_calls: None,
                reasoning: reasoning
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_string),
                is_completed: Some(false),
                is_collapsed: None,
            },
        )
        .await?;
        Ok(id)
    }

    pub(super) async fn update_assistant_checkpoint(
        &self,
        thread_id: &str,
        message_id: &str,
        content: &str,
        is_completed: Option<bool>,
        tool_calls: Option<&[LlmToolCall]>,
        reasoning: Option<&str>,
    ) -> Result<(), AgentError> {
        let tool_calls_json = tool_calls.map(serialize_tool_calls);
        let updated = self
            .thread_manager
            .update_assistant_checkpoint(
                thread_id,
                message_id,
                content,
                is_completed,
                tool_calls_json.as_ref(),
                reasoning,
            )
            .await?;
        if !updated {
            tracing::warn!(
                "[Agent] assistant checkpoint {message_id} for thread {thread_id} was not found"
            );
        }
        Ok(())
    }

    /// 鍔╂墜鏃㈣緭鍑轰簡鏂囨湰鍙堝彂鍑轰簡 tool_call 鐨勫悎骞惰惤鐩樸€侽penAI 鍗忚閲岃繖涓よ€呮湰灏辨槸
    /// 同一�?assistant 消息 (content + tool_calls 字�?), 不�?拆成两�?�?    /// text �?���?(LLM �?�� tool call, 不带前�?文本), calls 至少一�?�?
    pub(super) async fn flush_assistant_message_with_tool_calls(
        &self,
        thread_id: &str,
        content: &str,
        calls: &[LlmToolCall],
        reasoning: Option<&str>,
    ) -> Result<(), AgentError> {
        // 序列化为 OpenAI 格式�?JSON 数组, 持久化层�?rllm 解耦�?
        let tool_calls_json = serialize_tool_calls(calls);
        // 借用首个 call.id 作�? id, 保持�?tool_call 的�? row 共享前缀便于排查�?
        let id_seed = calls
            .first()
            .map(|c| c.id.clone())
            // LLM 整轮都没�?id (极少�? ── �?UUID 兜底, 避免同�?秒内的�?
            // �?call 拿到同一 id_seed �?PRIMARY KEY (issue #3.2)�?
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        self.add_thread_message(
            thread_id,
            ThreadChatMessage {
                id: format!("assistant_tool_{}", id_seed),
                role: MessageRole::Assistant.as_str().to_string(),
                content: content.to_string(),
                llm_content: None,
                system_reminder_directory: None,
                timestamp: chrono::Utc::now().to_rfc3339(),
                is_loading: None,
                tool_call_id: None,
                tool_name: None,
                tool_data: None,
                tool_input: None,
                tool_calls: Some(tool_calls_json),
                reasoning: reasoning
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_string),
                is_completed: None,
                is_collapsed: None,
            },
        )
        .await
    }

    pub(super) async fn persist_tool_call(
        &self,
        thread_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        tool_input: serde_json::Value,
    ) -> Result<(), AgentError> {
        // �?id 必须全局�?�� ── LLM 偶发不给 tool_call.id(罕�?但发生过),空字符串
        // 拼出来就�?"tool_",�?thread 内�?�?tool_call 全撞 PRIMARY KEY�?        // �?UUID 兜底, �?`flush_assistant_message_with_tool_calls` 同形 (issue #3.2)�?        // 这里**�?*改写 `tool_call_id` 列的�?── 那列�?�� `update_tool_result` �?        // WHERE 子句用的, 列空值的退化场�?LLM 一整轮都给�?id)在原始路径上根本
        // 进不到这�?PRIMARY KEY 已拒), 不属于本次修复�?解决的范围�?
        let row_id = tool_call_row_id(tool_call_id);
        self.add_thread_message(
            thread_id,
            ThreadChatMessage {
                id: row_id,
                role: MessageRole::Tool.as_str().to_string(),
                content: String::new(),
                llm_content: None,
                system_reminder_directory: None,
                timestamp: chrono::Utc::now().to_rfc3339(),
                is_loading: Some(true),
                tool_call_id: Some(tool_call_id.to_string()),
                tool_name: Some(tool_name.to_string()),
                tool_data: None,
                tool_input: Some(tool_input),
                tool_calls: None,
                reasoning: None,
                is_completed: None,
                is_collapsed: None,
            },
        )
        .await
    }

    pub(super) async fn persist_tool_result(
        &self,
        thread_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        result_content: &str,
    ) -> Result<(), AgentError> {
        self.thread_manager
            .update_tool_result(thread_id, tool_call_id, tool_name, result_content)
            .await?;
        Ok(())
    }
}
