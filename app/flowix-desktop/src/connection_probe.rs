//! 连接探测的结果类型 ── 偏好设置 "Test Connection" 按钮的 IPC 契约。
//!
//! 原先与旧内置 provider 共用, 旧 `probe_chat` 移除后, DeepSeek Harness 的
//! `test_connection` 仍是这些
//! 类型的消费者, 因此独立成顶层模块。类型形状是前端
//! `platform/tauri/client/agent.ts::TestConnectionResult` 的镜像,
//! 修改任何字段都是破坏 IPC 契约。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TestConnectionErrorKind {
    /// `AiModelConfig` itself is missing fields (provider / model / apiKey / apiUrl).
    BadConfig,
    /// The provider string isn't supported by the target runtime.
    UnsupportedProvider,
    /// 401 / 403, or an auth rejection outright.
    AuthFailed,
    /// 404: model id unknown, or endpoint path wrong.
    NotFound,
    /// 429: rate-limited by the upstream provider.
    RateLimited,
    /// 5xx: provider side outage.
    ServerError,
    /// 4xx other than 401/403/404/429: typically a bad request body
    /// (e.g. malformed model id).
    BadRequest,
    /// DNS / TCP / TLS failure surfaced from the transport layer.
    NetworkUnreachable,
    /// Provider returned a body that isn't valid JSON.
    InvalidResponse,
    /// Catch-all for retry-exceeded / provider errors / anything unexpected.
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionError {
    pub kind: TestConnectionErrorKind,
    /// Raw error message for the developer console / toast detail.
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionResult {
    pub ok: bool,
    pub latency_ms: u64,
    /// The model id that was actually probed. Echoed back so the UI can
    /// confirm "you tested *this* model", not whatever happens to be cached.
    pub model_id: String,
    /// First up-to-80 chars of the model's text response. Empty when the
    /// model only emitted reasoning / tool_calls (no final text).
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<TestConnectionError>,
}
