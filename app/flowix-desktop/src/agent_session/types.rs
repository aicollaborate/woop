use serde::{Deserialize, Serialize};

use crate::agent_types::AgentId;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadInfo {
    pub thread_id: String,
    pub agent_id: AgentId,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub llm_content: Option<String>,
    pub system_reminder_directory: Option<String>,
    pub timestamp: String,
    pub is_loading: Option<bool>,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub tool_data: Option<String>,
    pub tool_input: Option<serde_json::Value>,
    /// 助手消息关联�?tool_calls 数组 (OpenAI 格式 JSON, 单元素或多元�?�?    /// None 表示�?���?��手消�? Some(vec![...]) 表示该助手轮次同时发出了工具调用�?    /// 存储层用 serde_json::Value 避免�?rllm 类型耦合�?
    #[serde(default)]
    pub tool_calls: Option<serde_json::Value>,
    pub reasoning: Option<String>,
    pub is_completed: Option<bool>,
    pub is_collapsed: Option<bool>,
}

/// `ChatMessage.role` 的合法取值。存储层仍是 `String` (SQLite TEXT), 这个
/// 枚举仅用于写入/读取处消除 magic string, 编译期防拼错。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessageRole {
    User,
    Assistant,
    Tool,
    Reasoning,
    System,
    End,
}

impl MessageRole {
    pub const fn as_str(self) -> &'static str {
        match self {
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
            MessageRole::Tool => "tool",
            MessageRole::Reasoning => "reasoning",
            MessageRole::System => "system",
            MessageRole::End => "end",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "user" => Some(MessageRole::User),
            "assistant" => Some(MessageRole::Assistant),
            "tool" => Some(MessageRole::Tool),
            "reasoning" => Some(MessageRole::Reasoning),
            "system" => Some(MessageRole::System),
            "end" => Some(MessageRole::End),
            _ => None,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub info: ThreadInfo,
    pub messages: Vec<ChatMessage>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConversationSource {
    pub kind: String,
    pub document_path: Option<String>,
    pub memo_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConversationRole {
    pub memo_id: Option<String>,
    pub name: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConversationInstance {
    pub instance_id: String,
    pub agent_type: String,
    /// Product title projected from `threads.title`; it is not stored on the
    /// conversation-instance row. `None` means the card has not started a
    /// conversation yet.
    pub thread_title: Option<String>,
    pub thread_id: Option<String>,
    pub runtime_config: Option<String>,
    /// Backend-owned working directory frozen on the first external-agent run.
    /// It is deliberately not part of `UpsertAgentConversationInstance`, so a
    /// stale frontend runtime-config snapshot cannot overwrite it.
    pub frozen_cwd: Option<String>,
    pub source: AgentConversationSource,
    pub role: Option<AgentConversationRole>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentExternalEvent {
    pub id: i64,
    pub runtime: String,
    pub thread_id: String,
    pub event_key: Option<String>,
    pub normalized_json: String,
    pub raw_json: Option<String>,
    pub created_at: i64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAgentExternalEvent {
    pub runtime: String,
    pub thread_id: String,
    pub normalized_json: String,
    pub raw_json: Option<String>,
    pub created_at: Option<i64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertAgentConversationInstance {
    pub instance_id: String,
    pub agent_type: String,
    /// Initial title used only when `thread_id` needs a product thread row.
    /// Later title changes must go through the thread title command.
    pub initial_title: String,
    pub thread_id: Option<String>,
    pub runtime_config: Option<String>,
    pub source: AgentConversationSource,
    pub role: Option<AgentConversationRole>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
}

/// Layer 4: 分页加载的返回类型。前�?�� `oldest_sequence` 作为下一�?cursor,
/// `has_more` 决定�?��在顶部显�?加载更�?"或自�?prefetch�?
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMessagesPage {
    pub messages: Vec<ChatMessage>,
    /// �?��最早一条消�?�� sequence; None 表示�?��为空�?
    pub oldest_sequence: Option<i64>,
    /// �?��还有更早的历�? false 时前�?��止顶�?prefetch�?
    pub has_more: bool,
}
