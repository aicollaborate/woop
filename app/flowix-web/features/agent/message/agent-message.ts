import type { ChatMessage } from "@/types";
import { getToolLabel } from "@features/agent/message/tools";
import { stripSystemBlock } from "@features/agent/message/system";
import { isEmptyAssistantMessage } from "@features/agent/message/empty";
import {
  extractStandaloneAgentErrorMessage,
  formatAgentErrorMessage,
  formatDeepSeekHarnessReconnectError,
  isDeepSeekHarnessReconnectError,
} from "@features/agent/message/error-format";
import { translate, type AppLanguage, type I18nKey } from "@/lib/i18n";
import { getAgentToolInputSummary as getFallbackAgentToolInputSummary } from "@features/agent/tool-display";

export interface AgentMessageViewModel {
  message: ChatMessage;
  role: ChatMessage["role"];
  visibleContent: string;
  shouldRender: boolean;
  reasoningLabel: string;
  toolLabel: string;
  toolSummary: string;
  endTimeText: string;
}

const ERROR_GUIDANCE_KEYS: Readonly<Record<string, I18nKey>> = {
  authentication: "agent.error.guidance.authentication",
  rate_limited: "agent.error.guidance.rate_limited",
  network: "agent.error.guidance.network",
  session_not_found: "agent.error.guidance.session_not_found",
  model_not_found: "agent.error.guidance.model_not_found",
  context_length: "agent.error.guidance.context_length",
  content_policy: "agent.error.guidance.content_policy",
  invalid_request: "agent.error.guidance.invalid_request",
  process: "agent.error.guidance.process",
  provider: "agent.error.guidance.provider",
  unknown: "agent.error.guidance.unknown",
};

export function agentMessageValueToText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function getAgentToolInputSummary(
  input?: Record<string, unknown>,
): string {
  return getFallbackAgentToolInputSummary(input);
}

export function getAgentReasoningLabel(
  message: ChatMessage,
  language: AppLanguage = "zh-CN",
): string {
  return translate(
    language,
    message.isCompleted
      ? "agent.reasoning.completed"
      : "agent.reasoning.thinking",
  );
}

export function getAgentMessageEndTimeText(
  message: ChatMessage,
  language: AppLanguage = "zh-CN",
): string {
  if (!message.timestamp) {
    return new Date().toLocaleTimeString(
      language === "zh-CN" ? "zh-CN" : "en-US",
    );
  }

  const timestamp = new Date(message.timestamp);
  if (Number.isNaN(timestamp.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat(language === "zh-CN" ? "zh-CN" : "en-US", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

export function getAgentMessageVisibleContent(
  message: ChatMessage,
  language: AppLanguage = "zh-CN",
): string {
  if (message.role === "user") {
    return stripSystemBlock(message.content || "");
  }

  if (message.role === "end") {
    return message.content || getAgentMessageEndTimeText(message, language);
  }

  // assistant 错误消息 (历史 provider 合成的 LLM 不可用信封 / 外部 runtime 抛
  // 出的错误) 可能夹带 `Raw response: {json}`, 展示前收敛成 message; 普通
  // assistant 文本没有该标记, 原样返回。
  if (message.role === "assistant") {
    if (isDeepSeekHarnessReconnectError(message)) {
      return formatDeepSeekHarnessReconnectError(message, language);
    }
    return formatAgentErrorMessage(
      formatExternalAgentErrorMessage(
        message.content || "",
        message.errorDetails,
        language,
      ),
    );
  }

  return message.content || "";
}

function formatExternalAgentErrorMessage(
  content: string,
  details: ChatMessage["errorDetails"],
  language: AppLanguage,
): string {
  const upstream = details?.upstreamMessage?.trim();
  const rawBody = upstream || stripCliFailureWrapper(content.trim());
  const body = extractStandaloneAgentErrorMessage(rawBody) || rawBody;
  if (!body) return content;

  const diagnostics: string[] = [];
  if (details?.statusCode) diagnostics.push(`HTTP ${details.statusCode}`);
  if (details?.requestId) {
    diagnostics.push(
      translate(language, "agent.error.diagnostic.requestId", {
        value: details.requestId,
      }),
    );
  }
  if (details?.retryAfter) {
    diagnostics.push(
      translate(language, "agent.error.diagnostic.retryAfter", {
        value: details.retryAfter,
      }),
    );
  }
  if (details?.exitCode !== undefined) {
    diagnostics.push(
      translate(language, "agent.error.diagnostic.exitStatus", {
        value: details.exitCode,
      }),
    );
  }
  const guidanceKey = details?.category
    ? ERROR_GUIDANCE_KEYS[details.category]
    : undefined;
  const guidance = guidanceKey ? translate(language, guidanceKey) : "";
  return [body, guidance, diagnostics.join(" · ")].filter(Boolean).join("\n\n");
}

function stripCliFailureWrapper(content: string): string {
  const match = content.match(
    /^(?:Claude Code CLI|Codex CLI) exited with status (?:exit status:\s*)?[^:]+:\s*(.+)$/is,
  );
  return match?.[1]?.trim() || content;
}

export function shouldRenderAgentMessage(message: ChatMessage): boolean {
  return !isEmptyAssistantMessage(message);
}

export function createAgentMessageViewModel(
  message: ChatMessage,
  language: AppLanguage = "zh-CN",
): AgentMessageViewModel {
  return {
    message,
    role: message.role,
    visibleContent: getAgentMessageVisibleContent(message, language),
    shouldRender: shouldRenderAgentMessage(message),
    reasoningLabel: getAgentReasoningLabel(message, language),
    toolLabel: getToolLabel(
      { agentType: message.toolAgentType, toolName: message.toolName },
      language,
    ),
    toolSummary:
      message.toolDisplay?.summary ||
      getAgentToolInputSummary(message.toolInput),
    endTimeText: getAgentMessageEndTimeText(message, language),
  };
}
