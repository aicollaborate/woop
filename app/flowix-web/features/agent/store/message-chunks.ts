import type {
  ApplyResult,
  LiveMessageState,
} from "@features/agent/store/chunk-result";
import type { ChatMessage } from "@/types";
import type { AgentErrorDetails, AgentMessageType } from "@/types/agent";
import { insertAgentMessageBySourceOrder } from "@features/agent/store/message-order";

export interface MessageChunkMetadata {
  id?: string;
  messageType?: AgentMessageType;
  notice?: "deepseek-harness-reconnect-failed";
  phase?: "started" | "updated" | "completed";
  contentMode?: "delta" | "snapshot";
  sourceTimestamp?: number;
  sourceSequence?: number;
  sourceSubsequence?: number;
  errorDetails?: AgentErrorDetails;
  codexTurnId?: string;
  /**
   * Run-scoped id of the optimistic user row. When a provider user item
   * arrives with its own id (Codex item/completed), the optimistic row is
   * adopted in place instead of growing a duplicate.
   */
  optimisticId?: string;
}

let generatedAssistantMessageSequence = 0;

function isGoalControlMessageType(
  value: AgentMessageType | undefined,
): value is Extract<AgentMessageType, `goal-${string}`> {
  return (
    value === "goal-round" ||
    value === "goal-complete" ||
    value === "goal-blocked"
  );
}

function generatedAssistantMessageId(): string {
  generatedAssistantMessageSequence += 1;
  return `assistant-${Date.now()}-${generatedAssistantMessageSequence}`;
}

export function applyUserMessageChunk(
  st: LiveMessageState,
  text: string,
  metadata: MessageChunkMetadata & { id: string },
): ApplyResult {
  // DSH goal rounds and terminal wrap-up prompts are provider-owned control
  // messages. Keep them in the timeline as compact system rows, never as a
  // human turn and never allow them to adopt/replace the optimistic user row.
  if (isGoalControlMessageType(metadata.messageType)) {
    const existingIndex = st.messages.findIndex(
      (message) => message.id === metadata.id,
    );
    const message: ChatMessage = {
      id: metadata.id,
      role: "system",
      content: text,
      messageType: metadata.messageType,
      timestamp: messageTimestamp(metadata.sourceTimestamp),
      sourceTimestamp: metadata.sourceTimestamp,
      sourceSequence: metadata.sourceSequence,
      sourceSubsequence: metadata.sourceSubsequence,
      codexTurnId: metadata.codexTurnId,
      isCompleted: true,
    };
    const messages = [...st.messages];
    if (existingIndex >= 0) messages[existingIndex] = message;
    else messages.push(message);
    return {
      messages,
      pendingAssistantId: null,
      pendingReasoningId: null,
    };
  }

  // Codex relays the provider userMessage item id (with the owning turn id)
  // as soon as the turn starts. Adopt it in place: rewrite the optimistic
  // run-scoped row's id instead of appending a second user row. Position,
  // content and neighbouring references stay untouched, so the renderer's
  // patch-last fast path keeps holding while the row is still the tail.
  if (
    metadata.codexTurnId &&
    metadata.optimisticId &&
    metadata.id !== metadata.optimisticId
  ) {
    const optimisticIndex = st.messages.findIndex(
      (message) =>
        message.role === "user" &&
        message.id === metadata.optimisticId &&
        !message.codexTurnId,
    );
    if (optimisticIndex >= 0) {
      const optimistic = st.messages[optimisticIndex];
      const messages = [...st.messages];
      messages[optimisticIndex] = {
        ...optimistic,
        id: metadata.id,
        // The provider item may contain DSH-injected system-reminder/runtime
        // context. The optimistic row is the product-owned source of the
        // user-visible text; keep it when adopting the provider identity.
        codexTurnId: metadata.codexTurnId,
      };
      return {
        messages,
        pendingAssistantId: null,
        pendingReasoningId: null,
      };
    }
  }

  // A Codex user item can race the synthetic lifecycle event and arrive with
  // a different run-scoped id.  The turn is authoritative here; when the
  // optimistic id is unavailable, adopt the newest unacknowledged user row
  // with the same visible text instead of appending a second row.  Restrict
  // this fallback to the tail so identical prompts from older turns never
  // collapse into the current turn.
  if (metadata.codexTurnId) {
    const optimisticIndex = [...st.messages].reverse().findIndex(
      (message) =>
        message.role === "user" &&
        !message.codexTurnId &&
        message.content === text,
    );
    if (optimisticIndex >= 0) {
      const index = st.messages.length - 1 - optimisticIndex;
      const optimistic = st.messages[index];
      const messages = [...st.messages];
      messages[index] = {
        ...optimistic,
        id: metadata.id,
        // See the provider-id adoption path above: runtime context belongs to
        // the model prompt, never to the rendered user message.
        codexTurnId: metadata.codexTurnId,
      };
      return {
        messages,
        pendingAssistantId: null,
        pendingReasoningId: null,
      };
    }
  }

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
      codexTurnId: existing.codexTurnId ?? metadata.codexTurnId,
    };
    return {
      messages,
      // A user row starts a new turn. Never let a late/missed stream_end make
      // the next assistant delta append to the previous turn's message.
      pendingAssistantId: null,
      pendingReasoningId: null,
    };
  }

  // User events are turn boundaries in the live event stream. They must stay
  // after the already rendered transcript even when the provider attaches a
  // stale/turn-local source timestamp (Codex commonly uses sequence 0 for
  // every turn's user item). History pagination is the only path that may
  // prepend older messages.
  return {
    messages: [...st.messages, {
      id: metadata.id,
      role: "user",
      content: text,
      timestamp: messageTimestamp(metadata.sourceTimestamp),
      sourceTimestamp: metadata.sourceTimestamp,
      sourceSequence: metadata.sourceSequence,
      sourceSubsequence: metadata.sourceSubsequence,
      codexTurnId: metadata.codexTurnId,
    }],
    pendingAssistantId: null,
    pendingReasoningId: null,
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
    // Completed-item snapshots are re-sent by design (item/completed plus
    // the turn/completed fallback). When the snapshot matches the streamed
    // content, keep every reference intact so duplicate delivery is a store
    // no-op instead of a fresh object graph.
    if (metadata.contentMode === "snapshot" && existing.content === text) {
      return {
        messages: closedMessages,
        pendingAssistantId: metadata.phase === "completed" ? null : targetId,
        pendingReasoningId: null,
      };
    }
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
      codexTurnId: existing.codexTurnId ?? metadata.codexTurnId,
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
      codexTurnId: metadata.codexTurnId,
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
    codexTurnId: metadata.codexTurnId,
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
    // Snapshot idempotency: identical content and completion state keep the
    // row reference (and the array) untouched for duplicate snapshots.
    if (
      metadata.contentMode === "snapshot" &&
      existing.content === text &&
      (existing.isCompleted ?? false) === (metadata.phase === "completed")
    ) {
      return {
        messages: st.messages,
        pendingReasoningId: metadata.phase === "completed" ? null : targetId,
        pendingAssistantId: st.pendingAssistantId,
      };
    }
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
  metadata: Pick<MessageChunkMetadata, "id" | "notice" | "errorDetails"> = {},
): ApplyResult {
  const closedMessages = st.pendingReasoningId
    ? st.messages.map((m) =>
        m.id === st.pendingReasoningId ? { ...m, isCompleted: true } : m,
      )
    : st.messages;
  const id = metadata.id ?? `error-${Date.now()}`;
  const existingIndex = closedMessages.findIndex(
    (item) => item.id === id && item.role === "assistant",
  );
  if (existingIndex >= 0) {
    // Keep the first error body (usually the provider's stdout error), but
    // enrich it if a later lifecycle error carries structured diagnostics.
    const existing = closedMessages[existingIndex];
    const messages = [...closedMessages];
    messages[existingIndex] = {
      ...existing,
      content: existing.content || message,
      errorDetails: existing.errorDetails ?? metadata.errorDetails,
    };
    return {
      messages,
      pendingAssistantId: null,
      pendingReasoningId: null,
    };
  }

  return {
    messages: [
      ...closedMessages,
      {
        id,
        role: "assistant",
        content: message,
        timestamp: new Date().toISOString(),
        ...(metadata.notice ? { notice: metadata.notice } : {}),
        ...(metadata.errorDetails
          ? { errorDetails: metadata.errorDetails }
          : {}),
      },
    ],
    pendingAssistantId: null,
    pendingReasoningId: null,
  };
}
