use serde::{Deserialize, Serialize};

use crate::agent_types::{StatusInfo, UsageInfo};

/// `agent-chunk` 浜嬩欢閲岀殑 `agent_type` 瀛楁 鈹€鈹€ Flowix 璺緞鍐欐 "flowix",
/// �?CLI managers �?`FlowixProviderKind::Flowix.key()` 对齐。前�?/// `dispatchAgentChunk` 拿这�?��做�?runtime �?���?fallback (e.g. Codex /
/// Claude / Gemini 不会�?`agent_type` �? �?`threadTypes[tid]` 兜底,
/// Flowix 直接走这条不需�?fallback)�?
pub(super) const FLOWIX_AGENT_TYPE: &str = "flowix";

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePathConfig {
    pub cwd: Option<String>,
    #[serde(default)]
    pub workspace_paths: Vec<String>,
    /// Sandbox / 鏉冮檺妗ｄ綅 鈹€鈹€ "read-only" / "workspace-write" /
    /// "danger-full-access" / "inherit"銆?鍚?CLI 鑷 normalize銆?
    pub permission_mode: Option<String>,
    /// LLM model id(若�? provider �?���?���?�?
    /// 閫氱敤 metadata 鍗忚瀛楁 鈹€鈹€ `StreamStart` chunk 閫氳繃 `model_for_runtime` 鍙栧€笺€?
    pub model: Option<String>,
    /// 推理 effort("low" / "medium" / "high" / "xhigh")�?
    /// 通用 metadata 协�?字�?,Provider 不支持时�?None�?
    pub reasoning_effort: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeConfig {
    pub flowix: Option<RuntimePathConfig>,
    pub codex: Option<RuntimePathConfig>,
    pub claude: Option<RuntimePathConfig>,
    pub hermes: Option<RuntimePathConfig>,
    pub opencode: Option<RuntimePathConfig>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentUserMessage {
    pub content: String,
    pub llm_content: Option<String>,
    #[serde(default)]
    pub image_paths: Vec<String>,
    pub run_id: Option<String>,
    pub system_reminder_directory: Option<String>,
    /// 閫変腑 Agent 绫诲瀷 鈹€鈹€ `'flowix' | 'codex' | 'claude'` (JSON wire: `agentType`).
    /// 前�? chat-store.ts `agent.chatStream()` �?���?���?payload 字�?.
    /// 后�?按值分�?(�?`commands/agent.rs:chat_with_agent_stream`).
    pub agent_type: Option<String>,
    pub runtime_config: Option<AgentRuntimeConfig>,
    pub permission_mode: Option<String>,
    pub codex_model: Option<String>,
    pub codex_reasoning_effort: Option<String>,
    pub agent_role_memo_id: Option<String>,
    pub agent_role_name: Option<String>,
    /// Product-owned conversation title. The command persists this to
    /// `threads.title` before any runtime process can resolve a session id.
    pub conversation_title: Option<String>,
}

impl AgentUserMessage {
    /// 共享 accessor ── 所�?dispatch 方法都从这里取�? runtime 的配�?�?    /// 早期实现�?7 �?��法各�?match typeKey, 现在统一一处�?
    fn runtime_config_for(&self, runtime: &str) -> Option<&RuntimePathConfig> {
        let config = self.runtime_config.as_ref()?;
        match runtime {
            "flowix" => config.flowix.as_ref(),
            "codex" => config.codex.as_ref(),
            "claude" => config.claude.as_ref(),
            "hermes" => config.hermes.as_ref(),
            "opencode" => config.opencode.as_ref(),
            _ => None,
        }
    }

    pub fn cwd_for_runtime(&self, runtime: &str) -> Option<&str> {
        self.runtime_config_for(runtime)
            .and_then(|config| config.cwd.as_deref())
            .or(self.system_reminder_directory.as_deref())
    }

    pub fn permission_mode_for_runtime(&self, runtime: &str) -> Option<&str> {
        self.runtime_config_for(runtime)
            .and_then(|config| config.permission_mode.as_deref())
            .or(self.permission_mode.as_deref())
    }

    pub fn workspace_paths_for_runtime(&self, runtime: &str) -> Vec<String> {
        self.runtime_config_for(runtime)
            .map(|config| config.workspace_paths.clone())
            .unwrap_or_default()
    }

    pub fn runtime_workspace_paths_for_runtime(&self, runtime: &str) -> Option<Vec<String>> {
        self.runtime_config_for(runtime)
            .map(|config| config.workspace_paths.clone())
    }

    pub fn codex_model_for_runtime(&self) -> Option<&str> {
        self.model_for_runtime("codex")
    }

    pub fn codex_reasoning_effort_for_runtime(&self) -> Option<&str> {
        self.reasoning_effort_for_runtime("codex")
    }

    /// 通用: 任意 provider �?model 字�?(�?StreamStart chunk 使用)�?    /// 优先�?`runtime_config.{type}.model` �? fallback 到顶�?`codex_model` 字�?�?
    pub fn model_for_runtime(&self, runtime: &str) -> Option<&str> {
        self.runtime_config_for(runtime)
            .and_then(|config| config.model.as_deref())
            .or(self.codex_model.as_deref())
    }

    /// 通用: 任意 provider �?reasoning effort�?
    pub fn reasoning_effort_for_runtime(&self, runtime: &str) -> Option<&str> {
        self.runtime_config_for(runtime)
            .and_then(|config| config.reasoning_effort.as_deref())
            .or(self.codex_reasoning_effort.as_deref())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatResponse {
    /// Fire-and-forget 后永远是空串 ── `chat_stream` 内部 spawn 后立�?
    /// `Ok(String::new())` 返回。真正的助手回答�?`agent-chunk` 事件�?
    /// `Text` / `Reasoning` 变体。保留字段是为了不破坏既�?IPC 形状�?
    pub response: String,
}

/// `agent_running_threads` IPC 返回�?── 一�?thread_id �?元信�?���?���?/// �?��时前�?��一�? seed `threadStates[].isLoading = true`�?///
/// `started_at` 用�? UI 显示"X 分钟前开�?; Phase 1 主�?�?isLoading 布尔�?/// `current_tool` 暂为 None (�?[`AgentManager::running_threads`])�?
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunInfo {
    pub started_at: i64,
    pub current_tool: Option<String>,
    pub agent_type: Option<String>,
    pub run_id: Option<String>,
    /// Registry key used when the process was started. External CLIs may later
    /// resolve a provider-native session id; keeping this lets stop/reconcile
    /// distinguish the local launch id from the canonical session id.
    pub pending_thread_id: Option<String>,
    /// Provider-native session id once reported by the external CLI.
    pub session_id: Option<String>,
}

impl RunInfo {
    pub fn active(
        started_at: i64,
        current_tool: Option<&str>,
        agent_type: Option<&str>,
        run_id: Option<String>,
        pending_thread_id: Option<String>,
        session_id: Option<String>,
    ) -> Self {
        Self {
            started_at,
            current_tool: current_tool.map(str::to_string),
            agent_type: agent_type.map(str::to_string),
            run_id,
            pending_thread_id,
            session_id,
        }
    }
}

/// agent 流式协�? —emit �?`agent-chunk` 事件, 前�? `client.ts:listenToAgentStream`
/// �?`listen<AgentChunk>` 接收。前�?TypeScript 镜像�?/// `app/flowix-web/types/agent.ts` 的同名类型�?///
/// �?`#[serde(tag = "kind")]` 内部标�?, 前�? `switch (chunk.kind)` 判别;
/// 鏇挎崲涔嬪墠 `[REASONING]:` / `[TOOL_CALL]:` / `[TOOL_RESULT]:` / `[ERROR]:`
/// 字�?串前缀协�? ── 那�?协�?�?[ERROR] chunk 会�?前�? fallthrough 当成�?��文�?/// 拼到 assistant 正文, 这里�?��构化错�?事件�?///
/// **每个变体都带 `thread_id`** —多�?话后台并行时, 前�? store �?thread_id
/// 派发�?`threadStates[tid]`, 互不串台�?///
/// **Wire 形状**: Tauri `app.emit("agent-chunk", &chunk)` 不经�?IPC 参数
/// camelCase �?��, 直接�?serde 序列化结果。`AgentChunk` 使用内部 tag:
/// `kind` �?snake_case 输出, 字�?名保�?snake_case ── `thread_id` �?JSON 里就�?`thread_id`�?/// TS �?listener 拿到�?`payload.thread_id` �?Rust 字�?同名
/// (与现�?`memo-event` �?`payload.memo` / `payload.source` 命名习惯一�?�?/// 这跟 IPC command args/returns �?`camelCase` 约定�?��套�?�?──
/// 后者有 Tauri �?���?��, 前者没�? 不�?混�?///
/// `StreamStart` / `StreamEnd` �?��命周期变�? �?`chat_stream` 外层�?/// insert / remove cancel_flag 时各 emit 一�?── 覆盖所有退出路�?/// (Ok / Err / panic-via-drop)。前�?��它们收敛 `isLoading`, 不再依赖
/// IPC `chat_with_agent_stream` �?await finally �?(�?IPC 在新模型�?/// 立即返回, 不再等待 stream 跑完)�?
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentChunk {
    /// Product-owned user message. External runtimes persist this before
    /// StreamStart so their normalized event log is a complete display source
    /// and does not need transcript rows mixed into it on replay.
    UserMessage {
        thread_id: String,
        id: String,
        text: String,
        timestamp: i64,
    },
    /// 鍔╂墜娴佸紡鍥炵瓟 (鏅€?content)
    Text { thread_id: String, text: String },
    /// 推理模型的思考过�?(reasoning_content)
    Reasoning { thread_id: String, text: String },
    /// LLM 发出的工具调�?
    ToolCall {
        thread_id: String,
        id: String,
        name: String,
        input: serde_json::Value,
    },
    /// 宸ュ叿鎵ц缁撴灉
    ToolResult {
        thread_id: String,
        id: String,
        name: String,
        result: serde_json::Value,
    },
    /// 错�?事件 (卡�? / �?cycle / stream error / not configured �?
    // TODO: evolve into a structured variant ({ kind: "stuck" | "max_cycles" |
    // "stream" | "not_configured", ... }) when the frontend needs to discriminate
    // error sources. v1 keeps the message as opaque String 鈹€鈹€ the wire shape
    // crosses the IPC boundary as JSON and is parsed by `chat-store.ts:switch`.
    Error { thread_id: String, message: String },
    /// Stream 开�?── chat_stream 入口 insert cancel_flag �?emit 一欰�?
    /// 前�?借�?把�?�?thread �?`isLoading` �?true�?
    ///
    /// **`model` / `reasoning_effort` �?? run 锁定�?LLM 配置** ──
    /// 由后�?�� spawn 时��?从用户配�?CLI override 解析),不依�?
    /// streaming 响应�?��露的 model 字�?(部分 provider 不返�?�?
    /// 通用协�?: �?OpenAI / Codex / Claude / Gemini 等所�?provider 一致�?
    /// 字�?均为 Option,�?provider 暂不识别时为 None,前�? fallback �?
    /// 全局配置或显�?"—,不破坏协�?�?
    StreamStart {
        thread_id: String,
        model: Option<String>,
        reasoning_effort: Option<String>,
    },
    /// Stream 结束 ── chat_stream 出口 remove cancel_flag �?emit 一欰�?
    /// 覆盖所有退出路�?(Ok / Err / panic)。`reason` �?�? 留作�?��
    /// 鍖哄垎 "鑷劧瀹屾垚" vs "鐢ㄦ埛涓诲姩 stop" vs "stuck 鐔旀柇" 绛夊満鏅€?
    StreamEnd {
        thread_id: String,
        reason: Option<String>,
    },
    /// Token usage increment 鈥?emitted multiple times per run (per turn /
    /// per stream tail). Token counts are accumulated by the frontend into
    /// `AgentRunState.usage`. `model_id` and `last_run_at` are top-level
    /// metadata, not nested under `usage`. `usage` is the nested token
    /// breakdown (see [`UsageInfo`]). `status_info` is the provider-specific
    /// status snapshot (see [`StatusInfo`]). Compatibility fields
    /// `prompt_tokens` / `completion_tokens` are no longer part of the wire 鈥?    /// SSE parse layer maps them to `input_tokens` / `output_tokens` first.
    Usage {
        thread_id: String,
        model_id: Option<String>,
        last_run_at: Option<i64>,
        usage: Option<UsageInfo>,
        status_info: Option<StatusInfo>,
    },
    /// External CLI runtime resolved a temporary frontend thread id to the
    /// durable provider session id. The frontend uses this to canonicalize
    /// document thread ids without polling.
    SessionResolved {
        thread_id: String,
        session_id: String,
    },
}

impl AgentChunk {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::UserMessage { .. } => "user_message",
            Self::Text { .. } => "text",
            Self::Reasoning { .. } => "reasoning",
            Self::ToolCall { .. } => "tool_call",
            Self::ToolResult { .. } => "tool_result",
            Self::Error { .. } => "error",
            Self::StreamStart { .. } => "stream_start",
            Self::StreamEnd { .. } => "stream_end",
            Self::SessionResolved { .. } => "session_resolved",
            Self::Usage { .. } => "usage",
        }
    }

    pub fn thread_id(&self) -> &str {
        match self {
            Self::UserMessage { thread_id, .. }
            | Self::Text { thread_id, .. }
            | Self::Reasoning { thread_id, .. }
            | Self::ToolCall { thread_id, .. }
            | Self::ToolResult { thread_id, .. }
            | Self::Error { thread_id, .. }
            | Self::StreamStart { thread_id, .. }
            | Self::StreamEnd { thread_id, .. }
            | Self::SessionResolved { thread_id, .. }
            | Self::Usage { thread_id, .. } => thread_id,
        }
    }
}
/// Agent-layer error converted to strings at the IPC boundary.
#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("thread error: {0}")]
    Thread(#[from] crate::agent_session::ThreadError),
    #[error("user config error: {0}")]
    UserConfig(#[from] crate::config::UserConfigError),
    #[error("llm provider error: {0}")]
    LlmProvider(String),
    #[error("ai model not configured; open Preferences → Agent to set model and api key")]
    NotConfigured,
    #[error("agent stuck: tool '{tool}' called {count} times with identical arguments")]
    Stuck { tool: String, count: u32 },
    /// 单�? `chat_stream` 跨所�?cycle �??�?`total_tokens` 超出 ai_config �?    /// �?`max_total_tokens` 上限 ── 配合 `finalize_with_synthesized_message` �?    /// "assistant 正常收口 + emit Error chunk" �?��, �?`Stuck` 同形, UI 不弹
    /// 閿欒 toast銆俙used` / `budget` 涓€骞跺甫鍥炰究浜庡墠绔睍绀虹敤閲忋€?
    #[error("token budget exceeded: used {used} of {budget} total tokens")]
    TokenBudget { used: u32, budget: u32 },
}
