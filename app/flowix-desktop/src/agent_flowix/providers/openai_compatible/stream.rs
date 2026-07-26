use std::collections::BTreeMap;

use rllm::{FunctionCall as LlmFunctionCall, ToolCall as LlmToolCall};

use super::types::ApiStreamToolCall;

#[derive(Default)]
pub(super) struct PendingToolCall {
    id: String,
    call_type: String,
    name: String,
    arguments: String,
}

/// In-flight tool calls within one assistant turn, keyed by the LLM-assigned
/// `index` on each `tool_calls` delta. BTreeMap (not HashMap) gives
/// deterministic ascending-order iteration when we flush at
/// `finish_reason == "tool_calls"` and at end-of-stream. The number of
/// parallel tool calls in a single turn is small (typically <= 4), so the
/// BTreeMap overhead is negligible.
pub(super) type PendingToolCalls = BTreeMap<usize, PendingToolCall>;

pub(super) fn merge_tool_call_delta(pending: &mut PendingToolCalls, calls: Vec<ApiStreamToolCall>) {
    for tc in calls {
        let idx = tc.index.unwrap_or(0);
        let entry = pending.entry(idx).or_default();
        if let Some(id) = tc.id {
            if !id.is_empty() {
                entry.id = id;
            }
        }
        if let Some(call_type) = tc.call_type {
            if !call_type.is_empty() {
                entry.call_type = call_type;
            }
        }
        if let Some(function) = tc.function {
            if let Some(name) = function.name {
                if !name.is_empty() {
                    entry.name = name;
                }
            }
            if let Some(arguments) = function.arguments {
                entry.arguments.push_str(&arguments);
            }
        }
    }
}

/// Drain all in-flight buckets into a sorted list of `LlmToolCall`s.
/// Half-formed buckets (empty `name`) are skipped. Used at both
/// `finish_reason == "tool_calls"` and at end-of-stream; the caller's
/// choice to wrap each result in `OpenAICompatibleStreamItem::ToolUseComplete`
/// is the only thing that differs between the two sites.
pub(super) fn flush_pending_tool_calls(pending: &mut PendingToolCalls) -> Vec<LlmToolCall> {
    let drained: Vec<(usize, PendingToolCall)> = pending
        .iter_mut()
        .map(|(k, v)| (*k, std::mem::take(v)))
        .collect();
    let mut out = Vec::with_capacity(drained.len());
    for (idx, p) in drained {
        if p.name.is_empty() {
            tracing::debug!(
                "[OpenAI] skipping half-formed tool_call bucket at index {}",
                idx
            );
            continue;
        }
        out.push(LlmToolCall {
            id: if p.id.is_empty() {
                format!("call_{}_{}", idx, chrono::Utc::now().timestamp_millis())
            } else {
                p.id
            },
            call_type: if p.call_type.is_empty() {
                "function".to_string()
            } else {
                p.call_type
            },
            function: LlmFunctionCall {
                name: p.name,
                arguments: p.arguments,
            },
        });
    }
    pending.clear();
    out
}

/// OpenAI provider 内部流事�?—推理模型�?`reasoning_content` 与普�?`content`
/// 分开表达, 避免再走 "�?content 里�? `[REASONING]:` 前缀" 的字符串协�?�?/// rllm �?`StreamChunk` �?�� `Text(String)` 表达文本, 没法区分两类文本,
/// 所以这里引入自己的 enum ── agent.rs 直接消费这�?。trait �?���?/// `chat_stream_with_tools` 已废�?(unimplemented!); 该路径的 reasoning
/// 包�? (`[REASONING]:` 前缀回填) 跟着删掉, 避免�??�?
#[derive(Debug, Clone)]
pub enum OpenAICompatibleStreamItem {
    /// 鍔╂墜娴佸紡鍥炵瓟 (鏅€?content)
    Text(String),
    /// 推理模型的思考过�?(reasoning_content)
    Reasoning(String),
    /// LLM 鍙戝嚭宸ュ叿璋冪敤, 宸茶仛鍚堝畬 (id/call_type/function{name,arguments} 榻愬叏)
    ToolUseComplete { tool_call: LlmToolCall },
    /// 流末尾的 token 计数 (OpenAI 协�?在最后一�?SSE chunk 的顶�?`usage` 字�?
    /// 单独�? 不混�?`choices` �?。`total_tokens` �?���?None 时整�?Usage �?emit�?    ///
    /// Compatibility: 鏃?provider 鍙姤 `prompt_tokens` / `completion_tokens`
    /// �? SSE 解析层会 fallback �?input/output;这里�?��载新协�?字�?,
    /// wire 形状不再透传 prompt/completion�?
    Usage {
        total_tokens: u32,
        input_tokens: Option<u32>,
        cached_input_tokens: Option<u32>,
        output_tokens: Option<u32>,
        reasoning_output_tokens: Option<u32>,
        model_context_window: Option<u32>,
    },
    /// 流结�?(OpenAI `[DONE]` 或流�?���?
    Done {
        #[allow(dead_code)]
        stop_reason: String,
    },
}
