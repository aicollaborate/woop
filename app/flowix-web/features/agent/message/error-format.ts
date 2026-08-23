import type { ChatMessage } from "@/types";
import { translate, type AppLanguage } from "@/lib/i18n";

const DEEPSEEK_HARNESS_ERROR_ID =
  /^msg:deepseek-harness:[^:]+:error:/;
const DEEPSEEK_HARNESS_MESSAGE_MAX_CHARS = 240;

/**
 * DeepSeek Harness error events are materialized as assistant messages by
 * both the live reducer and the external-event history loader. The notice
 * field covers live events; the canonical id keeps already-persisted history
 * recognizable after reload.
 */
export function isDeepSeekHarnessReconnectError(message: ChatMessage): boolean {
  return (
    message.notice === "deepseek-harness-reconnect-failed" ||
    DEEPSEEK_HARNESS_ERROR_ID.test(message.id)
  );
}

export function formatDeepSeekHarnessReconnectError(
  message: ChatMessage,
  language: AppLanguage,
): string {
  const reason = formatDeepSeekHarnessFailureMessage(message.content || "");
  return [
    translate(language, "agent.deepseekHarness.reconnectFailed"),
    translate(language, "agent.deepseekHarness.failureReason", { reason }),
  ].join("\n\n");
}

/**
 * Harness runtime errors may put the complete stderr/stack trace in the
 * message string. The conversation only needs the actual error message; the
 * diagnostic tail remains available to the runtime logging path.
 */
function formatDeepSeekHarnessFailureMessage(content: string): string {
  const normalized = formatAgentErrorMessage(content)
    .replace(/\r\n/g, "\n")
    .trim();
  if (!normalized) return normalized;

  const firstMessageLine = normalized
    .split("\n")
    .map(line => line.trim())
    .find(line => line !== "" && !/^stderr tail:?$/i.test(line));
  if (!firstMessageLine) return normalized;

  // Desktop protocol prefixes runtime errors with their machine-readable
  // code, e.g. "[HARNESS_RUN_FAILED] JSON-RPC input closed". The code is
  // useful for diagnostics but is not part of the user-facing message.
  const message = firstMessageLine.replace(/^\[[^\]]+\]\s*/, "");
  return truncateErrorMessage(message);
}

function truncateErrorMessage(value: string): string {
  const chars = Array.from(value);
  if (chars.length <= DEEPSEEK_HARNESS_MESSAGE_MAX_CHARS) return value;
  return `${chars.slice(0, DEEPSEEK_HARNESS_MESSAGE_MAX_CHARS).join("")}…`;
}

/**
 * 把 agent 错误消息里夹带的原始 JSON 收敛成人类可读的 message。
 *
 * 历史内置 provider 失败时, Rust 侧 `format_llm_unavailable_message`
 * 会合成 `(LLM 暂时不可用，原因: Stream failed: Response format error:
 * API error 400. Raw response: {"error":{"message":...}})` —— `Raw response:`
 * 后面是上游返回的整段 JSON, 直接展示既刺眼又把 `request_id` 之类噪音暴露
 * 给用户。
 *
 * Rust 侧已在新错误里做了同样的收敛 (见 `extract_llm_error_message`);
 * 这里是展示层的兜底: 修这条之前**已落盘**的历史消息, 以及将来任何带上
 * `Raw response:` 的错误内容, 在渲染时统一收敛成干净信封, 不用迁移旧数据。
 * 没有 `Raw response:` 的普通内容原样返回 (no-op)。
 */
export function formatAgentErrorMessage(content: string): string {
  if (!content) return content;
  // Guard: only the legacy LLM-unavailable envelope starts with "(LLM ".
  // Requiring it (plus the "Raw response:" marker) keeps normal assistant text
  // -- even a debugging answer that happens to quote "Raw response: {json}" --
  // untouched.
  if (!content.startsWith("(LLM ")) return content;
  const marker = "Raw response: ";
  const idx = content.indexOf(marker);
  if (idx < 0) return content;
  const message = extractJsonErrorMessage(content.slice(idx + marker.length));
  if (!message) return content;
  return `(LLM 暂时不可用，原因: ${message})`;
}

/** 取 `text` 里首个 `{...}` JSON 对象的 error message; 解析失败返回 null。 */
function extractJsonErrorMessage(text: string): string | null {
  const json = extractFirstJsonObject(text);
  if (!json) return null;
  try {
    return pickErrorMessage(JSON.parse(json) as unknown);
  } catch {
    return null;
  }
}

/**
 * Brace-match `text` 里首个 `{...}` JSON 对象, 跳过字符串字面量内的大括号,
 * 避免被 JSON 内部的 `}` 提前截断。旧 provider 把上游 body 原样拼在 `Raw response:`
 * 之后, body 之后可能还跟别的文本, 所以不能直接 `JSON.parse` 整段。
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 常见 LLM provider 错误信封里取 message 的优先级: Anthropic / OpenAI 用
 * `error.message`; 兜底: 顶层 `message`、`error` 字符串、`detail`。
 */
function pickErrorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const error = obj.error;
  if (error && typeof error === "object") {
    const msg = (error as Record<string, unknown>).message;
    if (typeof msg === "string" && msg) return msg;
  }
  if (typeof obj.message === "string" && obj.message) return obj.message;
  if (typeof error === "string" && error) return error;
  if (typeof obj.detail === "string" && obj.detail) return obj.detail;
  return null;
}
