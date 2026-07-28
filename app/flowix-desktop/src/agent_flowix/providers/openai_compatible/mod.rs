//! OpenAI Chat Completions provider for rllm-compatible agent framework.
//!
//! This module provides a generic OpenAI-compatible provider that uses
//! the /v1/chat/completions endpoint, suitable for MiniMax, DeepSeek, and
//! other OpenAI-compatible APIs.

mod constants;
mod media;
mod retry;
mod stream;
mod types;

pub use stream::OpenAICompatibleStreamItem;

use futures::stream::Stream;
use futures::StreamExt;
use reqwest::Client;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use rllm::chat::{ChatMessage as LlmChatMessage, ChatResponse, ChatRole, MessageType};
use rllm::error::LLMError as RllmError;
use rllm::ToolCall as LlmToolCall;

use self::constants::{
    DEFAULT_REQUEST_WALLCLOCK_SECS, DEFAULT_STREAM_WALLCLOCK_SECS, MAX_IMAGE_BYTES,
    MAX_INITIAL_REQUEST_ATTEMPTS, MAX_VIDEO_BYTES,
};
use self::media::{
    asset_url_to_path, encode_resized_image_data_url, extract_image_sources, extract_video_sources,
    file_url_to_path, mime_from_content_type, mime_from_source, video_mime_from_source,
};
use self::retry::{format_reqwest_error, is_retryable_status, retry_delay};
use self::stream::{flush_pending_tool_calls, merge_tool_call_delta, PendingToolCalls};
use self::types::{
    text_content, ApiStreamChunk, ChatCompletionsRequest, ChatCompletionsResponse, ChatContentPart,
    ChatMessageContent, ChatMessageReq, FunctionSchema, ImageUrlContent, ToolReq, VideoUrlContent,
};

#[derive(Debug, Clone)]
pub struct OpenAICompatibleChatMessage {
    pub role: ChatRole,
    pub content: String,
    pub message_type: MessageType,
    pub reasoning: Option<String>,
}

impl From<LlmChatMessage> for OpenAICompatibleChatMessage {
    fn from(message: LlmChatMessage) -> Self {
        Self {
            role: message.role,
            content: message.content,
            message_type: message.message_type,
            reasoning: None,
        }
    }
}

impl OpenAICompatibleChatMessage {
    pub fn to_llm_message(&self) -> LlmChatMessage {
        LlmChatMessage {
            role: self.role.clone(),
            content: self.content.clone(),
            message_type: self.message_type.clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct OpenAICompatibleConfig {
    pub api_key: String,
    pub model: String,
    pub base_url: String,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub system: Option<String>,
    pub timeout_seconds: Option<u64>,
    pub reasoning_split: Option<bool>,
    pub include_reasoning_content: bool,
    pub multimodal_user_content: bool,
}

impl OpenAICompatibleConfig {
    pub fn new(
        api_key: impl Into<String>,
        model: impl Into<String>,
        base_url: impl Into<String>,
    ) -> Self {
        Self {
            api_key: api_key.into(),
            model: model.into(),
            base_url: base_url.into(),
            max_tokens: None,
            temperature: None,
            system: None,
            timeout_seconds: None,
            reasoning_split: None,
            include_reasoning_content: false,
            multimodal_user_content: false,
        }
    }

    #[allow(dead_code)]
    pub fn with_max_tokens(mut self, max_tokens: u32) -> Self {
        self.max_tokens = Some(max_tokens);
        self
    }

    #[allow(dead_code)]
    pub fn with_temperature(mut self, temperature: f32) -> Self {
        self.temperature = Some(temperature);
        self
    }

    pub fn with_system(mut self, system: impl Into<String>) -> Self {
        self.system = Some(system.into());
        self
    }

    #[allow(dead_code)]
    pub fn with_timeout(mut self, timeout_seconds: u64) -> Self {
        self.timeout_seconds = Some(timeout_seconds);
        self
    }

    pub fn with_reasoning_split(mut self, reasoning_split: bool) -> Self {
        self.reasoning_split = Some(reasoning_split);
        self
    }

    pub fn with_reasoning_content(mut self, enabled: bool) -> Self {
        self.include_reasoning_content = enabled;
        self
    }

    #[allow(dead_code)]
    pub fn with_multimodal_user_content(mut self, enabled: bool) -> Self {
        self.multimodal_user_content = enabled;
        self
    }
}

/// OpenAI-compatible provider using /v1/chat/completions endpoint.
/// 流式入口�?[`Self::chat_stream_tagged`] ── 拿结构化 `OpenAICompatibleStreamItem`
/// (reasoning / text 分�?, �?`[REASONING]:` 字�?串前缀)。非流式�?/// [`Self::chat_with_tools`] ── `AgentChatProvider::chat_with_tools` �?/// Rllm 流式不支持时降级到非流式时调�?
#[derive(Debug, Clone)]
pub struct OpenAICompatibleProvider {
    config: Arc<OpenAICompatibleConfig>,
    client: Client,
}

impl OpenAICompatibleProvider {
    pub fn new(config: OpenAICompatibleConfig) -> Self {
        // �?`connect_timeout` 限制握手, `read_timeout` 容忍长流式生成期�?        // 单帧空闲 —之前一�?60s `Client::timeout()` �?*�?*超时, 推理
        // 模型首字节慢 + �?payload write 工具下一�?reload 三者一叠加�?        // 容易在流还没开始时就�?�?��, 错�?还会�?reqwest �?`Kind::Decode`
        // 包�?成�?导性的 "error decoding response body"�?        //
        // 不再设总超�? `read_timeout(120s)` 在每�?frame 收到时重�? �?        // 生成�??持续�?chunk 就不会触�? 真�?兜底�?��调用方按 cycle
        // �?wall-clock cap, 不应该在这一层硬切�?
        let client = Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .read_timeout(std::time::Duration::from_secs(120))
            // L1-a: 关掉 hyper 透明解压 —SSE 流的 chunked body 不应�?            //        gzip/brotli �?��层改�? 否则 zstd 头解析失败会冒泡�?            //        Kind::Decode, 根因其实�?网关注入透明解压"。同�?            //        �?Accept-Encoding: identity 显式声明"不压�?,
            .no_gzip()
            // L1-b: 30s 心跳 —�?��网络设�? NAT / 防火�?60-90s 静默切断
            .tcp_keepalive(std::time::Duration::from_secs(30))
            .pool_idle_timeout(std::time::Duration::from_secs(90))
            .build()
            .expect("Failed to build reqwest Client");
        Self {
            config: Arc::new(config),
            client,
        }
    }

    #[allow(dead_code)]
    pub fn with_client(client: Client, config: OpenAICompatibleConfig) -> Self {
        Self {
            config: Arc::new(config),
            client,
        }
    }

    /// 非流�?chat completion ── �?`AgentChatProvider::chat_with_tools`
    /// fallback �?���?(Rllm 分支流式不支持时降级到非流式)。agent.rs:192
    /// 直接 `provider.chat_with_tools(...)` 调用, 不走 rllm trait dispatch�?
    pub async fn chat_with_tools(
        &self,
        messages: &[OpenAICompatibleChatMessage],
        tools: Option<&[rllm::chat::Tool]>,
    ) -> Result<Box<dyn ChatResponse>, RllmError> {
        if self.config.api_key.is_empty() {
            return Err(RllmError::AuthError("Missing API key".to_string()));
        }

        let msgs = self.prepare_messages(messages).await?;

        let tool_requests = tools.map(|tools| {
            tools
                .iter()
                .map(|t| ToolReq {
                    tool_type: "function".to_string(),
                    function: FunctionSchema {
                        name: t.function.name.clone(),
                        description: t.function.description.clone(),
                        parameters: t.function.parameters.clone(),
                    },
                })
                .collect()
        });

        let request = ChatCompletionsRequest {
            model: self.config.model.clone(),
            messages: msgs,
            max_tokens: self.config.max_tokens,
            temperature: self.config.temperature,
            stream: false,
            parallel_tool_calls: tool_requests.as_ref().map(|_| false),
            tools: tool_requests,
            reasoning_split: self.config.reasoning_split,
        };

        let url = self.build_url();
        let timeout = Duration::from_secs(
            self.config
                .timeout_seconds
                .unwrap_or(DEFAULT_REQUEST_WALLCLOCK_SECS),
        );
        let mut last_retryable_error: Option<RllmError> = None;
        let mut response = None;
        for attempt in 0..MAX_INITIAL_REQUEST_ATTEMPTS {
            let req = self
                .client
                .post(&url)
                .bearer_auth(&self.config.api_key)
                .header("Content-Type", "application/json")
                .header("Accept", "application/json")
                .timeout(timeout)
                .json(&request);

            match req.send().await {
                Ok(resp) if resp.status().is_success() => {
                    response = Some(resp);
                    break;
                }
                Ok(resp) => {
                    let status = resp.status();
                    let raw_response = resp.text().await.unwrap_or_default();
                    let err = RllmError::ResponseFormatError {
                        message: format!("API error {}", status.as_u16()),
                        raw_response,
                    };
                    if is_retryable_status(status) && attempt + 1 < MAX_INITIAL_REQUEST_ATTEMPTS {
                        tracing::warn!(
                            "[OpenAI] retrying request after retryable status {} (attempt {}/{})",
                            status.as_u16(),
                            attempt + 1,
                            MAX_INITIAL_REQUEST_ATTEMPTS
                        );
                        last_retryable_error = Some(err);
                        tokio::time::sleep(retry_delay(attempt)).await;
                        continue;
                    }
                    return Err(err);
                }
                Err(e) => {
                    let err = RllmError::HttpError(format_reqwest_error(&e));
                    if attempt + 1 < MAX_INITIAL_REQUEST_ATTEMPTS {
                        tracing::warn!(
                            "[OpenAI] retrying request after send error (attempt {}/{}): {}",
                            attempt + 1,
                            MAX_INITIAL_REQUEST_ATTEMPTS,
                            e
                        );
                        last_retryable_error = Some(err);
                        tokio::time::sleep(retry_delay(attempt)).await;
                        continue;
                    }
                    return Err(err);
                }
            }
        }
        let response = response.ok_or_else(|| {
            last_retryable_error.unwrap_or_else(|| {
                RllmError::HttpError("request failed before response".to_string())
            })
        })?;

        let chat_response: ChatCompletionsResponse = response
            .json()
            .await
            .map_err(|e| RllmError::JsonError(e.to_string()))?;

        Ok(Box::new(chat_response))
    }

    fn build_url(&self) -> String {
        let base = self.config.base_url.trim_end_matches('/');
        // 鍏煎涓ょ鍏ュ弬褰㈠紡:
        //   - "base" (�?OpenAI �?https://api.openai.com/v1) —�?        //     追加 /chat/completions�?        //   - 完整 endpoint (�?DeepSeek 锁定�?        //     https://api.deepseek.com/chat/completions) —�?        //     已经包含�?��, 不再追加, 避免拼成 ".../chat/completions/chat/completions"�?
        if base.ends_with("/chat/completions") {
            base.to_string()
        } else {
            format!("{}/chat/completions", base)
        }
    }

    fn role_to_str(role: &ChatRole) -> &'static str {
        match role {
            ChatRole::User => "user",
            ChatRole::Assistant => "assistant",
        }
    }

    async fn load_image_data_url(&self, source: &str) -> Result<String, RllmError> {
        if source.to_ascii_lowercase().starts_with("http://")
            || source.to_ascii_lowercase().starts_with("https://")
        {
            let response = self
                .client
                .get(source)
                .timeout(Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| RllmError::HttpError(format_reqwest_error(&e)))?;

            if !response.status().is_success() {
                return Err(RllmError::HttpError(format!(
                    "failed to download image '{source}': HTTP {}",
                    response.status()
                )));
            }

            if let Some(len) = response.content_length() {
                if len as usize > MAX_IMAGE_BYTES {
                    return Err(RllmError::HttpError(format!(
                        "image '{source}' is too large: {len} bytes exceeds {MAX_IMAGE_BYTES} bytes"
                    )));
                }
            }

            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            let bytes = response
                .bytes()
                .await
                .map_err(|e| RllmError::HttpError(format_reqwest_error(&e)))?;
            let mime = mime_from_content_type(content_type.as_deref())
                .or_else(|| mime_from_source(source));
            return encode_resized_image_data_url(source, &bytes, mime);
        }

        let path = if source.to_ascii_lowercase().starts_with("file:///") {
            file_url_to_path(source)?
        } else if source
            .to_ascii_lowercase()
            .starts_with("asset://localhost/")
        {
            asset_url_to_path(source)?
        } else {
            PathBuf::from(source)
        };
        let bytes = tokio::fs::read(&path).await.map_err(|e| {
            RllmError::HttpError(format!(
                "failed to read local image '{}': {e}",
                path.display()
            ))
        })?;
        encode_resized_image_data_url(source, &bytes, mime_from_source(source))
    }

    async fn load_video_url(&self, source: &str) -> Result<String, RllmError> {
        let lower = source.to_ascii_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") {
            return Ok(source.to_string());
        }

        let path = if lower.starts_with("file:///") {
            file_url_to_path(source)?
        } else if lower.starts_with("asset://localhost/") {
            asset_url_to_path(source)?
        } else {
            PathBuf::from(source)
        };
        let metadata = tokio::fs::metadata(&path).await.map_err(|e| {
            RllmError::HttpError(format!(
                "failed to stat local video '{}': {e}",
                path.display()
            ))
        })?;
        if metadata.len() as usize > MAX_VIDEO_BYTES {
            return Err(RllmError::HttpError(format!(
                "video '{}' is too large: {} bytes exceeds {} bytes",
                path.display(),
                metadata.len(),
                MAX_VIDEO_BYTES
            )));
        }
        let bytes = tokio::fs::read(&path).await.map_err(|e| {
            RllmError::HttpError(format!(
                "failed to read local video '{}': {e}",
                path.display()
            ))
        })?;
        let mime = video_mime_from_source(source).unwrap_or("video/mp4");
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        Ok(format!("data:{mime};base64,{encoded}"))
    }

    async fn prepare_user_content(&self, content: &str) -> Result<ChatMessageContent, RllmError> {
        if !self.config.multimodal_user_content {
            return Ok(text_content(content));
        }

        let image_sources = extract_image_sources(content);
        let video_sources = extract_video_sources(content);
        if image_sources.is_empty() && video_sources.is_empty() {
            return Ok(text_content(content));
        }

        let mut parts = Vec::with_capacity(image_sources.len() + video_sources.len() + 1);
        parts.push(ChatContentPart::Text {
            text: content.to_string(),
        });
        for source in image_sources {
            let data_url = self.load_image_data_url(&source).await?;
            parts.push(ChatContentPart::ImageUrl {
                image_url: ImageUrlContent { url: data_url },
            });
        }
        for source in video_sources {
            let url = self.load_video_url(&source).await?;
            parts.push(ChatContentPart::VideoUrl {
                video_url: VideoUrlContent { url },
            });
        }
        Ok(ChatMessageContent::Parts(parts))
    }

    async fn prepare_messages(
        &self,
        messages: &[OpenAICompatibleChatMessage],
    ) -> Result<Vec<ChatMessageReq>, RllmError> {
        let mut result: Vec<ChatMessageReq> = Vec::with_capacity(messages.len() + 1);

        // Some OpenAI-compatible gateways (notably MiniMax) reject the whole
        // request when *any* message has an empty `content` field (2013:
        // "chat content is empty").  The connection probe intentionally
        // builds a provider with an empty system prompt, so do not serialize
        // that placeholder as a real message.
        if let Some(system) = self
            .config
            .system
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            result.push(ChatMessageReq {
                role: "system".to_string(),
                content: Some(text_content(system)),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
            });
        }

        // OpenAI requires each tool result to immediately follow its assistant
        // tool call. Persisted history can contain orphaned or incomplete tool
        // rows after retries/cancellations, so sanitize at the provider edge.
        let mut index = 0;
        while index < messages.len() {
            let msg = &messages[index];
            match &msg.message_type {
                MessageType::ToolUse(calls) => {
                    let mut consumed_results = 0;
                    let mut candidate_results: Vec<LlmToolCall> = Vec::new();
                    let mut lookahead = index + 1;

                    while lookahead < messages.len() {
                        match &messages[lookahead].message_type {
                            MessageType::ToolResult(results) => {
                                candidate_results.extend(results.iter().cloned());
                                consumed_results += 1;
                                lookahead += 1;
                            }
                            _ => break,
                        }
                    }

                    let matched_results: Vec<LlmToolCall> = calls
                        .iter()
                        .filter_map(|call| {
                            candidate_results
                                .iter()
                                .find(|result| result.id == call.id)
                                .cloned()
                        })
                        .collect();

                    if matched_results.len() != calls.len() {
                        tracing::warn!(
                            "[OpenAI] Skipping incomplete tool call exchange before request"
                        );
                        index += 1 + consumed_results;
                        continue;
                    }

                    // OpenAI permits null/omitted `content` for a pure tool
                    // call, but stricter compatible gateways do not.  A
                    // neutral transport-only fallback keeps the exchange
                    // valid without changing the persisted/UI transcript.
                    let content = if msg.content.trim().is_empty() {
                        Some(text_content("Tool call requested."))
                    } else {
                        Some(text_content(msg.content.clone()))
                    };
                    result.push(ChatMessageReq {
                        role: "assistant".to_string(),
                        content,
                        reasoning_content: self.reasoning_content_for(msg),
                        tool_calls: Some(calls.clone()),
                        tool_call_id: None,
                    });
                    for r in matched_results {
                        let tool_content = if r.function.arguments.trim().is_empty() {
                            "{}".to_string()
                        } else {
                            r.function.arguments.clone()
                        };
                        result.push(ChatMessageReq {
                            role: "tool".to_string(),
                            content: Some(text_content(tool_content)),
                            reasoning_content: None,
                            tool_calls: None,
                            tool_call_id: Some(r.id.clone()),
                        });
                    }
                    index += 1 + consumed_results;
                }
                MessageType::ToolResult(_) => {
                    tracing::warn!("[OpenAI] Skipping orphan tool result before request");
                    index += 1;
                }
                MessageType::Text => {
                    // Interrupted/cancelled runs and legacy databases may
                    // contain empty text rows. They carry no model context and
                    // strict gateways reject them, so drop them at the final
                    // provider boundary.
                    if msg.content.trim().is_empty() {
                        tracing::warn!(
                            "[OpenAI] Skipping empty {} text message before request",
                            Self::role_to_str(&msg.role)
                        );
                        index += 1;
                        continue;
                    }
                    let content = if matches!(msg.role, ChatRole::User) {
                        self.prepare_user_content(&msg.content).await?
                    } else {
                        text_content(msg.content.clone())
                    };
                    result.push(ChatMessageReq {
                        role: Self::role_to_str(&msg.role).to_string(),
                        content: Some(content),
                        reasoning_content: self.reasoning_content_for(msg),
                        tool_calls: None,
                        tool_call_id: None,
                    });
                    index += 1;
                }
                _ => {
                    // Image/Audio/Pdf/ImageURL: 当前应用�?���? 跳过避免悄悄丢消�?�?
                    tracing::warn!(
                        "[OpenAI] Skipping unsupported MessageType variant in prepare_messages"
                    );
                    index += 1;
                }
            }
        }

        Ok(result)
    }

    fn reasoning_content_for(&self, msg: &OpenAICompatibleChatMessage) -> Option<String> {
        if !self.config.include_reasoning_content || !matches!(msg.role, ChatRole::Assistant) {
            return None;
        }
        msg.reasoning
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
    }

    /// 内部分流式方�? �?[`OpenAICompatibleStreamItem`]。agent.rs 用这�?���?—�?    /// 它需要把 `reasoning_content` �?`content` 区分开, 然后构�?    /// [`crate::agent_flowix::AgentChunk`] 发给前�?。这�?OpenAICompatibleProvider
    /// �?��保留的流式入�? rllm trait 上的 `chat_stream_with_tools` �?    /// `unimplemented!()` (无活跃消费�? �?
    /// impl 注释)�?
    pub async fn chat_stream_tagged(
        &self,
        messages: &[OpenAICompatibleChatMessage],
        tools: Option<&[rllm::chat::Tool]>,
    ) -> Result<
        Pin<Box<dyn Stream<Item = Result<OpenAICompatibleStreamItem, RllmError>> + Send>>,
        RllmError,
    > {
        if self.config.api_key.is_empty() {
            return Err(RllmError::AuthError("Missing API key".to_string()));
        }

        let msgs = self.prepare_messages(messages).await?;

        // Convert rllm Tools to OpenAI tool format
        let tool_requests = tools.map(|tools| {
            tools
                .iter()
                .map(|t| ToolReq {
                    tool_type: "function".to_string(),
                    function: FunctionSchema {
                        name: t.function.name.clone(),
                        description: t.function.description.clone(),
                        parameters: t.function.parameters.clone(),
                    },
                })
                .collect()
        });

        let request = ChatCompletionsRequest {
            model: self.config.model.clone(),
            messages: msgs,
            max_tokens: self.config.max_tokens,
            temperature: self.config.temperature,
            stream: true,
            parallel_tool_calls: tool_requests.as_ref().map(|_| false),
            tools: tool_requests,
            reasoning_split: self.config.reasoning_split,
        };

        let url = self.build_url();
        let body =
            serde_json::to_string(&request).map_err(|e| RllmError::JsonError(e.to_string()))?;
        tracing::debug!("[OpenAI] Request body: {}", body);

        let timeout = Duration::from_secs(
            self.config
                .timeout_seconds
                .unwrap_or(DEFAULT_STREAM_WALLCLOCK_SECS),
        );
        let mut last_retryable_error: Option<RllmError> = None;
        let mut response = None;
        for attempt in 0..MAX_INITIAL_REQUEST_ATTEMPTS {
            let req = self
                .client
                .post(&url)
                .bearer_auth(&self.config.api_key)
                .header("Content-Type", "application/json")
                .header("Accept", "text/event-stream")
                // L1-d: 显式拒绝压缩 —�?builder.no_gzip() 双向保险,
                .header("Accept-Encoding", "identity")
                .timeout(timeout)
                .body(body.clone());

            match req.send().await {
                Ok(resp) if resp.status().is_success() => {
                    response = Some(resp);
                    break;
                }
                Ok(resp) => {
                    let status = resp.status();
                    let raw_response = resp.text().await.unwrap_or_default();
                    let err = RllmError::ResponseFormatError {
                        message: format!("API error {}", status.as_u16()),
                        raw_response,
                    };
                    if is_retryable_status(status) && attempt + 1 < MAX_INITIAL_REQUEST_ATTEMPTS {
                        tracing::warn!(
                            "[OpenAI] retrying stream request after retryable status {} (attempt {}/{})",
                            status.as_u16(),
                            attempt + 1,
                            MAX_INITIAL_REQUEST_ATTEMPTS
                        );
                        last_retryable_error = Some(err);
                        tokio::time::sleep(retry_delay(attempt)).await;
                        continue;
                    }
                    return Err(err);
                }
                Err(e) => {
                    let err = RllmError::HttpError(format_reqwest_error(&e));
                    if attempt + 1 < MAX_INITIAL_REQUEST_ATTEMPTS {
                        tracing::warn!(
                            "[OpenAI] retrying stream request after send error (attempt {}/{}): {}",
                            attempt + 1,
                            MAX_INITIAL_REQUEST_ATTEMPTS,
                            e
                        );
                        last_retryable_error = Some(err);
                        tokio::time::sleep(retry_delay(attempt)).await;
                        continue;
                    }
                    return Err(err);
                }
            }
        }
        let response = response.ok_or_else(|| {
            last_retryable_error.unwrap_or_else(|| {
                RllmError::HttpError("stream request failed before response".to_string())
            })
        })?;

        let stream = futures::stream::unfold(
            (
                response.bytes_stream(),
                String::new(),
                PendingToolCalls::new(),
                VecDeque::<Result<OpenAICompatibleStreamItem, RllmError>>::new(),
            ),
            |(mut byte_stream, mut sse_buffer, mut pending, mut queue)| async move {
                // Helper: convert one fully-formed tool call into the
                // stream-item shape and queue it. Wraps the per-call
                // event format so the `for tc in flush_pending_tool_calls(...)`
                // loops below stay one-liners.
                let enqueue = |q: &mut VecDeque<_>, tool_call: LlmToolCall| {
                    q.push_back(Ok(OpenAICompatibleStreamItem::ToolUseComplete {
                        tool_call,
                    }));
                };

                if let Some(item) = queue.pop_front() {
                    return Some((item, (byte_stream, sse_buffer, pending, queue)));
                }

                while let Some(chunk) = byte_stream.next().await {
                    let bytes = match chunk {
                        Ok(bytes) => bytes,
                        Err(e) => {
                            return Some((
                                Err(RllmError::HttpError(format_reqwest_error(&e))),
                                (byte_stream, sse_buffer, pending, queue),
                            ));
                        }
                    };

                    let text = String::from_utf8_lossy(&bytes).to_string();
                    tracing::debug!("[OpenAI] Received bytes, text length: {}", text.len());
                    sse_buffer.push_str(&text);

                    while let Some(newline_index) = sse_buffer.find('\n') {
                        let line: String = sse_buffer.drain(..=newline_index).collect();
                        let line = line.trim();
                        if !line.starts_with("data: ") {
                            continue;
                        }

                        let json_str = line.trim_start_matches("data: ").trim();
                        if json_str == "[DONE]" {
                            tracing::debug!("[OpenAI] Stream done");
                            queue.push_back(Ok(OpenAICompatibleStreamItem::Done {
                                stop_reason: "stop".to_string(),
                            }));
                            continue;
                        }

                        let Ok(response) = serde_json::from_str::<ApiStreamChunk>(json_str) else {
                            tracing::debug!("[OpenAI] Failed to parse stream JSON: {}", json_str);
                            continue;
                        };

                        for choice in response.choices {
                            let delta = choice.delta;

                            if let Some(reasoning) = delta.reasoning_content {
                                if !reasoning.is_empty() {
                                    tracing::debug!("[OpenAI] Got reasoning chunk: {}", reasoning);
                                    queue.push_back(Ok(OpenAICompatibleStreamItem::Reasoning(
                                        reasoning,
                                    )));
                                }
                            }

                            if let Some(content) = delta.content {
                                if !content.is_empty() {
                                    tracing::debug!("[OpenAI] Got text chunk: {}", content);
                                    queue.push_back(Ok(OpenAICompatibleStreamItem::Text(content)));
                                }
                            }

                            if let Some(tool_calls) = delta.tool_calls {
                                merge_tool_call_delta(&mut pending, tool_calls);
                            }

                            if choice.finish_reason.as_deref() == Some("tool_calls")
                                && !pending.is_empty()
                            {
                                // Drain ALL buckets in ascending index order.
                                // This is the parallel-call fix: emit one
                                // ToolUseComplete per index so the agent sees
                                // N independent tool calls.
                                for tc in flush_pending_tool_calls(&mut pending) {
                                    enqueue(&mut queue, tc);
                                }
                            }
                        }

                        // Token 用量在流�?��单独�?(顶层 `usage`, 不在 choices �?�?                        // 之前 `Usage` 字�?�?ApiStreamChunk 解析但从�??读取 ──
                        // 现在透传�?agent.rs 做跨 cycle �?�� + 预算熔断�?                        // total_tokens �?None (网关没填) 时不 emit, 避免�?                        // `Some(Usage { total_tokens: 0, .. })` 当成 0 token 计入�?                        //
                        // Compatibility fallback: 鏃?provider 鍙姤
                        // `prompt_tokens` / `completion_tokens` �?�?SSE 解析�?                        // 把它�?fallback �?`input_tokens` / `output_tokens`,
                        // 这样下游 chunk 协�?不再携带 prompt/completion 字�?�?
                        if let Some(usage) = response.usage {
                            if let Some(total) = usage.total_tokens {
                                queue.push_back(Ok(OpenAICompatibleStreamItem::Usage {
                                    total_tokens: total,
                                    input_tokens: usage.input_tokens.or(usage.prompt_tokens),
                                    cached_input_tokens: usage.cached_input_tokens.or_else(|| {
                                        usage
                                            .input_tokens_details
                                            .as_ref()
                                            .and_then(|details| details.cached_tokens)
                                            .or_else(|| {
                                                usage
                                                    .prompt_tokens_details
                                                    .as_ref()
                                                    .and_then(|details| details.cached_tokens)
                                            })
                                    }),
                                    output_tokens: usage.output_tokens.or(usage.completion_tokens),
                                    reasoning_output_tokens: usage.reasoning_output_tokens.or_else(
                                        || {
                                            usage
                                                .output_tokens_details
                                                .as_ref()
                                                .and_then(|details| details.reasoning_tokens)
                                                .or_else(|| {
                                                    usage
                                                        .completion_tokens_details
                                                        .as_ref()
                                                        .and_then(|details| {
                                                            details.reasoning_tokens
                                                        })
                                                })
                                        },
                                    ),
                                    model_context_window: usage.model_context_window,
                                }));
                            }
                        }
                    }

                    if let Some(item) = queue.pop_front() {
                        return Some((item, (byte_stream, sse_buffer, pending, queue)));
                    }
                }

                // Tail flush: stream ended without an explicit
                // finish_reason="tool_calls" (network cut, provider quirk).
                // Emit any half-complete buckets so they aren't silently
                // dropped.
                if !pending.is_empty() {
                    for tc in flush_pending_tool_calls(&mut pending) {
                        enqueue(&mut queue, tc);
                    }
                    if let Some(item) = queue.pop_front() {
                        return Some((item, (byte_stream, sse_buffer, pending, queue)));
                    }
                }

                None
            },
        );

        Ok(Box::pin(stream))
    }
}

#[cfg(test)]
mod tests;
