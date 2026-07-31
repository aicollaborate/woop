import type {
  ApplyResult,
  LiveMessageState,
} from "@features/agent/store/chunk-result";
import { insertAgentMessageBySourceOrder } from "@features/agent/store/message-order";

export interface MessageChunkMetadata {
  id?: string;
  phase?: "started" | "updated" | "completed";
  contentMode?: "delta" | "snapshot";
  sourceTimestamp?: number;
  sourceSequence?: number;
  sourceSubsequence?: number;
}

let generatedAssistantMessageSequence = 0;

function generatedAssistantMessageId(): string {
  generatedAssistantMessageSequence += 1;
  return `assistant-${Date.now()}-${generatedAssistantMessageSequence}`;
}

export function applyUserMessageChunk(
  st: LiveMessageState,
  text: string,
  metadata: MessageChunkMetadata & { id: string },
): ApplyResult {
  const existingIndex = st.messages.findIndex(
    (message) => message.id === metadata.id && message.role === "user",
  );
  if (existingIndex >= 0) {
    const existing = st.messages[existingIndex];
    const messages = [...st.messages];
    messages[existingIndex] = {
      ...existing,
      content: text,
      timestamp:
        existing.sourceTimestamp === undefined &&
        metadata.sourceTimestamp !== undefined
          ? messageTimestamp(metadata.sourceTimestamp)
          : existing.timestamp,
      sourceTimestamp: existing.sourceTimestamp ?? metadata.sourceTimestamp,
      sourceSequence: existing.sourceSequence ?? metadata.sourceSequence,
      sourceSubsequence:
        existing.sourceSubsequence ?? metadata.sourceSubsequence,
    };
    return {
      messages,
      pendingAssistantId: st.pendingAssistantId,
      pendingReasoningId: st.pendingReasoningId,
    };
  }

  return {
    messages: insertAgentMessageBySourceOrder(st.messages, {
      id: metadata.id,
      role: "user",
      content: text,
      timestamp: messageTimestamp(metadata.sourceTimestamp),
      sourceTimestamp: metadata.sourceTimestamp,
      sourceSequence: metadata.sourceSequence,
      sourceSubsequence: metadata.sourceSubsequence,
    }),
    pendingAssistantId: st.pendingAssistantId,
    pendingReasoningId: st.pendingReasoningId,
  };
}

function messageTimestamp(sourceTimestamp?: number): string {
  return Number.isFinite(sourceTimestamp)
    ? new Date(sourceTimestamp!).toISOString()
    : new Date().toISOString();
}

/**
 * 文本 chunk ── assistant 出文字。 流式断点 ↔ `pendingAssistantId`:
 * - 为 null 时开新一条
 * - 已存在时 append 已有那条的 content (content += text)
 *
 * 同时把上一条未完成的 reasoning 行 `isCompleted=true` 收尾 ── assistant
 * 接 reasoning 是常规 Pattern, 不收尾会留着"思考中"视觉残留。
 */
export function applyTextChunk(
  st: LiveMessageState,
  text: string,
  metadata: MessageChunkMetadata = {},
): ApplyResult {
  const closedMessages = st.pendingReasoningId
    ? st.messages.map((m) =>
        m.id === st.pendingReasoningId ? { ...m, isCompleted: true } : m,
      )
    : st.messages;
  const targetId = metadata.id ?? st.pendingAssistantId;
  const existingIndex = targetId
    ? closedMessages.findIndex(
        (message) => message.id === targetId && message.role === "assistant",
      )
    : -1;
  if (existingIndex >= 0 && targetId) {
    const existing = closedMessages[existingIndex];
    const messages = [...closedMessages];
    messages[existingIndex] = {
      ...existing,
      content:
        metadata.contentMode === "snapshot" ? text : existing.content + text,
      timestamp:
        existing.sourceTimestamp === undefined &&
        metadata.sourceTimestamp !== undefined
          ? messageTimestamp(metadata.sourceTimestamp)
          : existing.timestamp,
      sourceTimestamp: existing.sourceTimestamp ?? metadata.sourceTimestamp,
      sourceSequence: existing.sourceSequence ?? metadata.sourceSequence,
      sourceSubsequence:
        existing.sourceSubsequence ?? metadata.sourceSubsequence,
    };
    return {
      messages,
      pendingAssistantId: metadata.phase === "completed" ? null : targetId,
      pendingReasoningId: null,
    };
  }
  if (!targetId) {
    const id = generatedAssistantMessageId();
    const message = {
      id,
      role: "assistant" as const,
      content: text,
      timestamp: messageTimestamp(metadata.sourceTimestamp),
      sourceTimestamp: metadata.sourceTimestamp,
      sourceSequence: metadata.sourceSequence,
      sourceSubsequence: metadata.sourceSubsequence,
    };
    return {
      messages: insertAgentMessageBySourceOrder(closedMessages, message),
      pendingAssistantId: id,
      pendingReasoningId: null,
    };
  }

  const message = {
    id: targetId,
    role: "assistant" as const,
    content: text,
    timestamp: messageTimestamp(metadata.sourceTimestamp),
    sourceTimestamp: metadata.sourceTimestamp,
    sourceSequence: metadata.sourceSequence,
    sourceSubsequence: metadata.sourceSubsequence,
  };
  return {
    messages: insertAgentMessageBySourceOrder(closedMessages, message),
    pendingAssistantId: metadata.phase === "completed" ? null : targetId,
    pendingReasoningId: null,
  };
}

/**
 * reasoning chunk ── 与 text chunk 形态相同, 仅 `role: "reasoning"` 与
 * 默认 `isCompleted: false`。 注意 reasoning 行不会因为后续 text chunk
 * 收尾 ── 由 `applyTextChunk` 显式 close, 这里保持原状。
 */
export function applyReasoningChunk(
  st: LiveMessageState,
  text: string,
  metadata: MessageChunkMetadata = {},
): ApplyResult {
  const targetId = metadata.id ?? st.pendingReasoningId;
  const existingIndex = targetId
    ? st.messages.findIndex(
        (message) => message.id === targetId && message.role === "reasoning",
      )
    : -1;
  if (existingIndex >= 0 && targetId) {
    const existing = st.messages[existingIndex];
    const messages = [...st.messages];
    messages[existingIndex] = {
      ...existing,
      content:
        metadata.contentMode === "snapshot" ? text : existing.content + text,
      timestamp:
        existing.sourceTimestamp === undefined &&
        metadata.sourceTimestamp !== undefined
          ? messageTimestamp(metadata.sourceTimestamp)
          : existing.timestamp,
      sourceTimestamp: existing.sourceTimestamp ?? metadata.sourceTimestamp,
      sourceSequence: existing.sourceSequence ?? metadata.sourceSequence,
      sourceSubsequence:
        existing.sourceSubsequence ?? metadata.sourceSubsequence,
      // A later Claude tool cycle may append to the same run-scoped reasoning
      // row after assistant/tool output temporarily closed it.
      isCompleted: metadata.phase === "completed",
    };
    return {
      messages,
      pendingReasoningId: metadata.phase === "completed" ? null : targetId,
      pendingAssistantId: st.pendingAssistantId,
    };
  }
  if (!targetId) {
    const id = `reasoning-${Date.now()}`;
    return {
      messages: [
        ...st.messages,
        {
          id,
          role: "reasoning",
          content: text,
          timestamp: new Date().toISOString(),
          isCompleted: false,
        },
      ],
      pendingReasoningId: id,
      pendingAssistantId: st.pendingAssistantId,
    };
  }

  const message = {
    id: targetId,
    role: "reasoning" as const,
    content: text,
    timestamp: messageTimestamp(metadata.sourceTimestamp),
    sourceTimestamp: metadata.sourceTimestamp,
    sourceSequence: metadata.sourceSequence,
    sourceSubsequence: metadata.sourceSubsequence,
    isCompleted: metadata.phase === "completed",
  };
  return {
    messages: insertAgentMessageBySourceOrder(st.messages, message),
    pendingReasoningId: metadata.phase === "completed" ? null : targetId,
    pendingAssistantId: st.pendingAssistantId,
  };
}

/**
 * error chunk ── 关闭此 run 的 streaming:
 * - 关 pending reasoning (`isCompleted=true`)
 * - 清 pendingAssistantId / pendingReasoningId
 * - append 一条 assistant 错误卡片
 *
 * 否则迟到的 text/reasoning chunk 会 append 到已"失败"的 assistant 行,
 * 形成撕裂 (同一段流既 error 又继续说)。 assistant 行没有 isCompleted 字段,
 * 关闭靠"pendingAssistantId 切 null" + 下次 text chunk 走 create-new 路径。
 */
export function applyErrorChunk(
  st: LiveMessageState,
  message: string,
): ApplyResult {
  const closedMessages = st.pendingReasoningId
    ? st.messages.map((m) =>
        m.id === st.pendingReasoningId ? { ...m, isCompleted: true } : m,
      )
    : st.messages;
  return {
    messages: [
      ...closedMessages,
      {
        id: `error-${Date.now()}`,
        role: "assistant",
        content: message,
        timestamp: new Date().toISOString(),
      },
    ],
    pendingAssistantId: null,
    pendingReasoningId: null,
  };
}
