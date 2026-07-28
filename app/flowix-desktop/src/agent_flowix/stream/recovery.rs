#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::agent_flowix) enum LlmFailureKind {
    RetryableTransport,
    RetryableRateLimit,
    RetryableServer,
    RecoverableHistory,
    FatalAuth,
    FatalRequest,
    FatalContext,
    FatalNotFound,
    Unknown,
}

pub(in crate::agent_flowix) fn classify_llm_failure(reason: &str) -> LlmFailureKind {
    let lower = reason.to_ascii_lowercase();
    if is_recoverable_args_error(&lower) {
        return LlmFailureKind::RecoverableHistory;
    }
    if lower.contains("401")
        || lower.contains("403")
        || lower.contains("auth")
        || lower.contains("api key")
        || lower.contains("unauthorized")
        || lower.contains("forbidden")
    {
        return LlmFailureKind::FatalAuth;
    }
    if lower.contains("context length")
        || lower.contains("maximum context")
        || lower.contains("too many tokens")
        || lower.contains("token limit")
    {
        return LlmFailureKind::FatalContext;
    }
    if lower.contains("404") || lower.contains("not found") || lower.contains("model_not_found") {
        return LlmFailureKind::FatalNotFound;
    }
    if lower.contains("429") || lower.contains("rate limit") || lower.contains("too many requests")
    {
        return LlmFailureKind::RetryableRateLimit;
    }
    if lower.contains("500")
        || lower.contains("502")
        || lower.contains("503")
        || lower.contains("504")
        || lower.contains("server error")
        || lower.contains("bad gateway")
        || lower.contains("service unavailable")
        || lower.contains("gateway timeout")
    {
        return LlmFailureKind::RetryableServer;
    }
    if lower.contains("400")
        || lower.contains("bad request")
        || lower.contains("invalid request")
        || lower.contains("invalid_request")
    {
        return LlmFailureKind::FatalRequest;
    }
    if lower.contains("connection")
        || lower.contains("timeout")
        || lower.contains("timed out")
        || lower.contains("reset")
        || lower.contains("eof")
        || lower.contains("broken pipe")
        || lower.contains("decode")
        || lower.contains("dns")
        || lower.contains("tcp")
        || lower.contains("tls")
        || lower.contains("body")
        || lower.contains("stream")
        || lower.contains("network")
    {
        return LlmFailureKind::RetryableTransport;
    }
    LlmFailureKind::Unknown
}

pub(super) fn is_auto_resumable_mid_stream(kind: LlmFailureKind) -> bool {
    matches!(
        kind,
        LlmFailureKind::RetryableTransport
            | LlmFailureKind::RetryableRateLimit
            | LlmFailureKind::RetryableServer
    )
}

/// True if the LLM gateway's error message indicates a recoverable
/// tool-arguments problem (typically: 400 with concatenated/garbled JSON
/// from a prior turn). The recovery loop's sanitize-and-retry path is
/// only entered when this returns true; for other 4xx/5xx (auth, rate
/// limit, server) we synthesize and end immediately.
fn is_recoverable_args_error(reason: &str) -> bool {
    reason.contains("invalid function arguments") || reason.contains("tool_call_id")
}

pub(super) fn build_recovery_instruction(reason: &str) -> String {
    format!(
        "The previous assistant response in this same conversation was interrupted by a transient model or network error.\n\
         Continue from the last visible assistant message without repeating completed text.\n\
         Treat any tool results already present in the conversation as authoritative and do not repeat side-effecting tool calls unless a new call is necessary.\n\
         Interruption reason: {reason}"
    )
}

/// 从 LLM 错误字符串里提取人类可读的 message。
///
/// `rllm`/`llm` 的 `ResponseFormatError` 会把上游响应体原样拼成
/// `Response format error: {message}. Raw response: {raw_response}`,
/// 直接展示会把整段 JSON (`{"type":"error","error":{"message":...}}`)
/// 连同 `request_id` 之类噪音暴露给用户。这里定位 `Raw response: ` 之后
/// 的 JSON, 解析出 `.error.message` / `.message` / `.error` / `.detail`;
/// 解析不到则原样返回, 不丢信息。
pub(in crate::agent_flowix) fn extract_llm_error_message(reason: &str) -> String {
    let Some(idx) = reason.find("Raw response: ") else {
        return reason.to_string();
    };
    let rest = &reason[idx + "Raw response: ".len()..];
    let Some(json_obj) = extract_first_json_object(rest) else {
        return reason.to_string();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&json_obj) else {
        return reason.to_string();
    };
    pick_error_message(&value).unwrap_or_else(|| reason.to_string())
}

/// Brace-match `rest` 里首个 `{...}` JSON 对象, 跳过字符串字面量内的大
/// 括号, 避免被 JSON 内部的 `}` 提前截断。
fn extract_first_json_object(rest: &str) -> Option<String> {
    let bytes = rest.as_bytes();
    let start = bytes.iter().position(|&b| b == b'{')?;
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escape = false;
    for (i, &b) in bytes[start..].iter().enumerate() {
        if escape {
            escape = false;
            continue;
        }
        if in_string {
            match b {
                b'\\' => escape = true,
                b'"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(rest[start..start + i + 1].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

/// 常见 LLM provider 错误信封里取 message 的优先级: Anthropic / OpenAI
/// 用 `error.message`; 兜底: 顶层 `message`、`error` 字符串、`detail`。
fn pick_error_message(value: &serde_json::Value) -> Option<String> {
    let error = value.get("error");
    if let Some(msg) = error
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
    {
        return Some(msg.to_string());
    }
    if let Some(msg) = value.get("message").and_then(|m| m.as_str()) {
        return Some(msg.to_string());
    }
    if let Some(msg) = error.and_then(|e| e.as_str()) {
        return Some(msg.to_string());
    }
    if let Some(msg) = value.get("detail").and_then(|d| d.as_str()) {
        return Some(msg.to_string());
    }
    None
}

/// Build the user-facing message for an LLM-side failure. Pure function -
/// extracted from `synthesize_llm_unavailable` so it can be unit-tested
/// without a Tauri `AppHandle`. The `reason` comes from the caller's
/// `format!("Stream failed: {}", e)`; any embedded `Raw response: {json}`
/// is collapsed to its human `message` so the UI doesn't dump raw JSON.
pub(in crate::agent_flowix) fn format_llm_unavailable_message(reason: &str) -> String {
    let display = extract_llm_error_message(reason);
    format!("(LLM 暂时不可用，原因: {})", display)
}
