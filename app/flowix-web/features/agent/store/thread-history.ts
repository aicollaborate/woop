import type { ChatMessage, ThreadListItem } from "@/types";
import type { AgentTypeKey } from "@/types/agent";
import { stripSystemBlock } from "@features/agent/message";
import { createAgentToolDisplay } from "@features/agent/tool-display";
import { isEmptyAssistantMessage } from "@features/agent/message";
import {
  getAgentHistoryAdapter,
  type ThreadHistoryPage,
} from "@features/agent/store/agent-history-adapters";
import { completedRunUserMessageId } from "@features/agent/events/message-identity";

/** Layer 4: 单页大小. 每次加载 10 条, 用户向上翻页时每页同样 10 条. */
export const HISTORY_PAGE_SIZE = 10;

export async function listHistoryThreads(
  type: AgentTypeKey,
): Promise<ThreadListItem[]> {
  return getAgentHistoryAdapter(type).listThreads();
}

export async function findHistoryThreadInfo(
  type: AgentTypeKey,
  threadId: string,
  currentList: ThreadListItem[],
): Promise<ThreadListItem | undefined> {
  return (
    currentList.find((item) => item.threadId === threadId) ??
    (await listHistoryThreads(type)).find((item) => item.threadId === threadId)
  );
}

export async function getHistoryPage(
  type: AgentTypeKey,
  threadId: string,
  beforeSequence: number | null,
  limit: number,
): Promise<ThreadHistoryPage> {
  return getAgentHistoryAdapter(type).getPage(threadId, beforeSequence, limit);
}

export async function getInitialThreadHistory(
  type: AgentTypeKey,
  threadId: string,
  limit: number,
): Promise<ThreadHistoryPage> {
  return getAgentHistoryAdapter(type).getInitialHistory(threadId, limit);
}

export function filterRenderableHistoryMessages(
  messages: ChatMessage[],
): ChatMessage[] {
  return messages
    .filter((m) => !isEmptyAssistantMessage(m))
    .map((message) => {
      if (message.role !== "user") return message;
      const content = stripSystemBlock(message.content || "");
      return content === message.content ? message : { ...message, content };
    })
    .filter((message) => message.role !== "user" || message.content.trim() !== "");
}

// Cheap content fingerprint used as a Map key for dedup. Two independent
// FNV-1a 32-bit hashes combined give an effectively 64-bit collision space
// while walking each string only once with constant per-character work.
// Replaces JSON.stringify(content) which, on multi-MB assistant responses,
// allocated several MB of UTF-16 strings per message per rAF frame
// (syncRenderableMessages is invoked on every streaming flush). Collisions
// remain theoretically possible but vanishingly unlikely for chat history;
// the dedup logic treats a collision as "duplicate, skip" which is benign.
function contentFingerprint(content: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  const prime1 = 0x01000193;
  const prime2 = 0x85ebca6b;
  for (let i = 0; i < content.length; i += 1) {
    const c = content.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, prime1);
    h2 = Math.imul(h2 ^ c, prime2);
  }
  return `${h1 >>> 0}:${h2 >>> 0}`;
}

function userMessageStableKey(message: ChatMessage): string | null {
  if (message.role !== "user") return null;
  const contentFp = message.content ? contentFingerprint(message.content) : "";
  const llmFp = message.llmContent ? contentFingerprint(message.llmContent) : "";
  return `user:${contentFp}:${llmFp}:${message.systemReminderDirectory ?? ""}:${message.systemReminderDocumentPath ?? ""}`;
}

function userMessageVisibleKey(message: ChatMessage): string | null {
  if (message.role !== "user") return null;
  return `user:visible:${contentFingerprint(stripSystemBlock(message.content || ""))}`;
}

function messageContentStableKey(message: ChatMessage): string | null {
  if (message.role === "user") return userMessageVisibleKey(message);
  if (
    message.role === "assistant" ||
    message.role === "reasoning" ||
    message.role === "end"
  ) {
    const content = (message.content || "").replace(/\r\n/g, "\n").trim();
    if (!content) return null;
    return `${message.role}:${contentFingerprint(content)}`;
  }
  if (message.role === "tool" && message.toolCallId) {
    return `tool:${message.toolCallId}:${contentFingerprint(message.content || "")}`;
  }
  return null;
}

function toolCallIdentityKey(toolCallId: string): string {
  const marker = ":tool-call:";
  const markerIndex = toolCallId.lastIndexOf(marker);
  return markerIndex >= 0 ? toolCallId.slice(markerIndex + marker.length) : toolCallId;
}

export function hydrateToolDisplay(
  message: ChatMessage,
  agentType?: AgentTypeKey,
): ChatMessage {
  if (message.role !== "tool") return message;
  const toolAgentType = message.toolAgentType ?? agentType;
  if (message.toolDisplay && message.toolAgentType === toolAgentType)
    return message;
  let toolDisplay: ReturnType<typeof createAgentToolDisplay> = undefined;
  try {
    toolDisplay = createAgentToolDisplay({
      agentType: toolAgentType,
      toolName: message.toolName,
      input: message.toolInput,
    });
  } catch (err) {
    console.error("Failed to hydrate agent tool display:", err);
  }
  return toolDisplay || toolAgentType
    ? {
        ...message,
        toolAgentType,
        toolDisplay: toolDisplay ?? message.toolDisplay,
      }
    : message;
}

export function hydrateHistoricalMessages(
  messages: ChatMessage[],
  agentType?: AgentTypeKey,
): ChatMessage[] {
  return messages.map((message) => hydrateToolDisplay(message, agentType));
}

function mergeHistoricalToolMessage(
  existing: ChatMessage,
  historical: ChatMessage,
): ChatMessage {
  if (existing.role !== "tool" || historical.role !== "tool") return existing;
  // 历史优先(持久权威): id/content/timestamp/toolName/isLoading 取历史,
  // live 仅补充历史缺失的运行期字段。原先 `...existing` 在前导致合并消息
  // 用 live 的 id/content, 丢失历史持久数据。
  return {
    ...historical,
    toolData: historical.toolData || existing.toolData,
    toolInput: historical.toolInput ?? existing.toolInput,
    toolDisplay: historical.toolDisplay ?? existing.toolDisplay,
    toolAgentType: historical.toolAgentType ?? existing.toolAgentType,
  };
}

export function mergeHistoricalMessages(
  existing: ChatMessage[],
  historical: ChatMessage[],
  agentType?: AgentTypeKey,
): ChatMessage[] {
  const hydratedHistorical = hydrateHistoricalMessages(historical, agentType);
  if (existing.length === 0) return hydratedHistorical;

  let mergedExisting = existing;
  const seenIds = new Set(existing.map((message) => message.id));
  const existingToolIndexByCallId = new Map<string, number>();
  const existingUserCounts = new Map<string, number>();
  const existingVisibleUserCounts = new Map<string, number>();
  const existingContentCounts = new Map<string, number>();
  for (const [index, message] of existing.entries()) {
    if (message.role === "tool" && message.toolCallId) {
      existingToolIndexByCallId.set(message.toolCallId, index);
      existingToolIndexByCallId.set(toolCallIdentityKey(message.toolCallId), index);
    }

    const key = userMessageStableKey(message);
    if (key) {
      existingUserCounts.set(key, (existingUserCounts.get(key) ?? 0) + 1);
    }

    const visibleKey = userMessageVisibleKey(message);
    if (visibleKey) {
      existingVisibleUserCounts.set(
        visibleKey,
        (existingVisibleUserCounts.get(visibleKey) ?? 0) + 1,
      );
    }

    const contentKey = messageContentStableKey(message);
    if (contentKey) {
      existingContentCounts.set(
        contentKey,
        (existingContentCounts.get(contentKey) ?? 0) + 1,
      );
    }
  }

  const missing: ChatMessage[] = [];
  // 被 historical tool 合并替代的 existing tool 下标 ── 这些 live tool 不再
  // 占 existing 位置, 合并消息(代表历史 tool)放 missing 的历史顺序位置。
  const mergedExistingIndices = new Set<number>();
  for (const message of hydratedHistorical) {
    if (seenIds.has(message.id)) continue;

    if (message.role === "tool" && message.toolCallId) {
      const existingIndex =
        existingToolIndexByCallId.get(message.toolCallId) ??
        existingToolIndexByCallId.get(toolCallIdentityKey(message.toolCallId));
      if (existingIndex !== undefined) {
        if (mergedExisting === existing) mergedExisting = [...existing];
        // 合并消息代表历史 tool, 放历史顺序位置(missing); existing 的 live
        // tool 标记移除。原先替换 mergedExisting[existingIndex] 把合并消息留
        // 在 live 区(existing 位置, 通常最前), 破坏历史时间序。
        mergedExistingIndices.add(existingIndex);
        missing.push(
          mergeHistoricalToolMessage(mergedExisting[existingIndex], message),
        );
        continue;
      }
    }

    const key = userMessageStableKey(message);
    if (key) {
      const count = existingUserCounts.get(key) ?? 0;
      if (count > 0) {
        existingUserCounts.set(key, count - 1);
        const visibleKey = userMessageVisibleKey(message);
        if (visibleKey) {
          const visibleCount = existingVisibleUserCounts.get(visibleKey) ?? 0;
          if (visibleCount > 0) {
            existingVisibleUserCounts.set(visibleKey, visibleCount - 1);
            const contentKey = messageContentStableKey(message);
            if (contentKey) {
              const contentCount = existingContentCounts.get(contentKey) ?? 0;
              if (contentCount > 0)
                existingContentCounts.set(contentKey, contentCount - 1);
            }
          }
        }
        continue;
      }
    }

    const visibleKey = userMessageVisibleKey(message);
    if (visibleKey) {
      const count = existingVisibleUserCounts.get(visibleKey) ?? 0;
      if (count > 0) {
        existingVisibleUserCounts.set(visibleKey, count - 1);
        const contentKey = messageContentStableKey(message);
        if (contentKey) {
          const contentCount = existingContentCounts.get(contentKey) ?? 0;
          if (contentCount > 0)
            existingContentCounts.set(contentKey, contentCount - 1);
        }
        continue;
      }
    }

    const contentKey = messageContentStableKey(message);
    if (contentKey) {
      const count = existingContentCounts.get(contentKey) ?? 0;
      if (count > 0) {
        existingContentCounts.set(contentKey, count - 1);
        continue;
      }
    }

    missing.push(message);
  }

  // 按时间排序(同时戳时历史 order 小在前, 对齐 mergeMessagesForThreadRender)。
  // 原先 [...mergedExisting, ...missing] 不排序, live 区整体在历史前导致顺序
  // 错乱(合并消息卡在 live 区最前)。
  const survivingExisting = mergedExisting.filter(
    (_, index) => !mergedExistingIndices.has(index),
  );
  const ordered = [
    ...missing.map((message, order) => ({ message, order })),
    ...survivingExisting.map((message, order) => ({
      message,
      order: missing.length + order,
    })),
  ];
  return ordered
    .sort(
      (a, b) =>
        messageTime(a.message) - messageTime(b.message) || a.order - b.order,
    )
    .map(({ message }) => message);
}

function messageTime(message: ChatMessage): number {
  const timestamp = Date.parse(message.timestamp);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * Compare the render-relevant message shape while ignoring object identity.
 * History adapters return fresh objects, so replacing an equivalent message
 * array would otherwise cause a needless conversation re-render after every
 * completed run.
 */
export function areMessagesEquivalent(
  left: ChatMessage[],
  right: ChatMessage[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;

  return left.every((message, index) => {
    const other = right[index];
    return JSON.stringify({
      id: message.id,
      role: message.role,
      content: message.content,
      notice: message.notice,
      errorDetails: message.errorDetails,
      llmContent: message.llmContent,
      systemReminderDirectory: message.systemReminderDirectory,
      systemReminderDocumentPath: message.systemReminderDocumentPath,
      timestamp: message.timestamp,
      sourceTimestamp: message.sourceTimestamp,
      sourceSequence: message.sourceSequence,
      sourceSubsequence: message.sourceSubsequence,
      isLoading: message.isLoading ?? false,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      toolAgentType: message.toolAgentType,
      toolData: message.toolData,
      toolInput: message.toolInput,
      toolDisplay: message.toolDisplay,
      toolCalls: message.toolCalls,
      reasoning: message.reasoning,
      isCompleted: message.isCompleted ?? false,
      isCollapsed: message.isCollapsed ?? false,
    }) === JSON.stringify({
      id: other.id,
      role: other.role,
      content: other.content,
      notice: other.notice,
      errorDetails: other.errorDetails,
      llmContent: other.llmContent,
      systemReminderDirectory: other.systemReminderDirectory,
      systemReminderDocumentPath: other.systemReminderDocumentPath,
      timestamp: other.timestamp,
      sourceTimestamp: other.sourceTimestamp,
      sourceSequence: other.sourceSequence,
      sourceSubsequence: other.sourceSubsequence,
      isLoading: other.isLoading ?? false,
      toolCallId: other.toolCallId,
      toolName: other.toolName,
      toolAgentType: other.toolAgentType,
      toolData: other.toolData,
      toolInput: other.toolInput,
      toolDisplay: other.toolDisplay,
      toolCalls: other.toolCalls,
      reasoning: other.reasoning,
      isCompleted: other.isCompleted ?? false,
      isCollapsed: other.isCollapsed ?? false,
    });
  });
}

/**
 * Replace the just-completed live run with its persisted representation.
 * The stable user id is the run boundary, so older pages already loaded by the
 * user stay intact while partial assistant/tool rows from the live stream are
 * removed instead of being appended beside the final history rows.
 */
export function replaceCompletedRunWithHistory(
  existing: ChatMessage[],
  historical: ChatMessage[],
  runId: string,
  agentType?: AgentTypeKey,
): ChatMessage[] {
  const history = hydrateHistoricalMessages(historical, agentType);
  if (history.length === 0) return existing;
  const anchorId = completedRunUserMessageId(agentType, runId);
  const existingAnchor = existing.findIndex((message) => message.id === anchorId);
  const historyAnchor = history.findIndex((message) => message.id === anchorId);
  if (existingAnchor >= 0 && historyAnchor >= 0) {
    const runHistory = history.slice(historyAnchor);
    // `turn/completed` can race the App Server's history materialization. In
    // that window thread/turns/list may already contain the user/assistant
    // items but not the just-completed tool item. Do not let that partial
    // snapshot erase a tool row that was already received live. The next
    // history load will merge the authoritative item by call id.
    const historyToolIds = new Set(
      runHistory
        .filter((message) => message.role === "tool" && message.toolCallId)
        .map((message) => toolCallIdentityKey(message.toolCallId!)),
    );
    const missingLiveTools = existing
      .slice(existingAnchor)
      .filter(
        (message) =>
          message.role === "tool" &&
          message.toolCallId &&
          !historyToolIds.has(toolCallIdentityKey(message.toolCallId)),
      );
    // Reinsert live-only tools at their original position in the run.  The
    // completion snapshot can race rollout persistence, but appending these
    // rows made a tool that was between two assistant items jump to the end
    // of the conversation on the next render/re-entry.
    const historyIndexById = new Map(
      runHistory.map((message, index) => [message.id, index]),
    );
    const runExisting = existing.slice(existingAnchor);
    const toolPosition = new Map(
      missingLiveTools.map((tool) => [
        tool.id,
        runExisting.findIndex((message) => message.id === tool.id),
      ]),
    );
    const reconciledRun = [...runHistory];
    for (const tool of missingLiveTools) {
      const existingPosition = toolPosition.get(tool.id) ?? -1;
      let insertAt = reconciledRun.length;
      if (existingPosition >= 0) {
        // Find the next existing message that is present in the persisted
        // snapshot and insert immediately before it.
        for (let i = existingPosition + 1; i < runExisting.length; i += 1) {
          const nextExisting = runExisting[i];
          let nextIndex = historyIndexById.get(nextExisting.id);
          // A streaming assistant is commonly replaced by a new persisted
          // assistant id at completion. Align it by role in that case; the
          // run order is already known, so this does not make equal-content
          // messages from different turns collide.
          if (nextIndex === undefined) {
            let roleOrdinal = 0;
            for (let j = 0; j <= i; j += 1) {
              if (runExisting[j].role === nextExisting.role) roleOrdinal += 1;
            }
            const matching = reconciledRun
              .map((message, index) => ({ message, index }))
              .filter(({ message }) => message.role === nextExisting.role);
            nextIndex = matching[roleOrdinal - 1]?.index;
          }
          if (nextIndex !== undefined) {
            insertAt = nextIndex;
            break;
          }
        }
      }
      reconciledRun.splice(insertAt, 0, tool);
      for (const [id, index] of historyIndexById) {
        if (index >= insertAt) historyIndexById.set(id, index + 1);
      }
    }
    return [...existing.slice(0, existingAnchor), ...reconciledRun];
  }

  // Other runtimes may not yet expose run-scoped user ids. An exact overlap
  // still gives a safe page boundary; otherwise retain the normal merge path.
  const historyIndexById = new Map(history.map((message, index) => [message.id, index]));
  const existingOverlap = existing.findIndex((message) =>
    historyIndexById.has(message.id),
  );
  if (existingOverlap >= 0) {
    const historyOverlap = historyIndexById.get(existing[existingOverlap].id) ?? 0;
    return [...existing.slice(0, existingOverlap), ...history.slice(historyOverlap)];
  }
  return mergeHistoricalMessages(existing, history, agentType);
}

/**
 * Merge persisted/history messages with the in-memory live thread state for
 * rendering. Live messages are allowed to repeat the same visible user content
 * across turns; only already-hydrated historical counterparts at the same or an
 * earlier timestamp are suppressed.
 */
export function mergeMessagesForThreadRender(
  historyMessages: ChatMessage[],
  liveMessages: ChatMessage[],
  agentType?: AgentTypeKey,
): ChatMessage[] {
  if (historyMessages.length === 0) return liveMessages;
  if (liveMessages.length === 0) return historyMessages;

  const history = hydrateHistoricalMessages(historyMessages, agentType);
  const live = hydrateHistoricalMessages(liveMessages, agentType);
  const seenIds = new Set(history.map((message) => message.id));
  const historicalContentCounts = new Map<string, number>();
  const latestHistoricalTimeByContent = new Map<string, number>();

  for (const message of history) {
    const key = messageContentStableKey(message);
    if (!key) continue;
    historicalContentCounts.set(key, (historicalContentCounts.get(key) ?? 0) + 1);
    latestHistoricalTimeByContent.set(
      key,
      Math.max(latestHistoricalTimeByContent.get(key) ?? 0, messageTime(message)),
    );
  }

  const merged = history.map((message, index) => ({
    message,
    order: index,
  }));
  let order = history.length;

  for (const message of live) {
    if (seenIds.has(message.id)) continue;

    const key = messageContentStableKey(message);
    if (key) {
      const historicalCount = historicalContentCounts.get(key) ?? 0;
      const latestHistoricalTime = latestHistoricalTimeByContent.get(key) ?? 0;
      if (historicalCount > 0 && messageTime(message) <= latestHistoricalTime) {
        historicalContentCounts.set(key, historicalCount - 1);
        continue;
      }
    }

    merged.push({ message, order });
    seenIds.add(message.id);
    order += 1;
  }

  return merged
    .sort((a, b) => messageTime(a.message) - messageTime(b.message) || a.order - b.order)
    .map(({ message }) => message);
}

export function mergeLiveMessagesIntoRenderableMessages(
  existingMessages: ChatMessage[],
  liveMessages: ChatMessage[],
  agentType?: AgentTypeKey,
): ChatMessage[] {
  if (liveMessages.length === 0) return existingMessages;
  const live = hydrateHistoricalMessages(liveMessages, agentType);
  if (existingMessages.length === 0) return live;

  const liveById = new Map(live.map((message) => [message.id, message]));
  let changed = false;
  const updatedExisting = existingMessages.map((message) => {
    const liveMessage = liveById.get(message.id);
    if (!liveMessage || liveMessage === message) return message;
    changed = true;
    return liveMessage;
  });
  const merged = mergeMessagesForThreadRender(updatedExisting, live, agentType);
  if (
    !changed &&
    merged.length === existingMessages.length &&
    merged.every((message, index) => message === existingMessages[index])
  ) {
    return existingMessages;
  }
  return merged;
}

/**
 * 流式 fast path: 若 `renderable` 与 `current` 仅最后一条消息的内容不同
 * (同 id 同 role, 前 N-1 条引用全等), 直接返回替换末条后的新数组, 跳过
 * [`mergeLiveMessagesIntoRenderableMessages`] 的全量 fingerprint + sort
 * (O(N·L) -> O(N) 引用比较)。流式 text_delta / reasoning_delta 每次只追加
 * 末条内容, 前 N-1 条引用不变, 命中率极高。
 *
 * - 返回 `current` 本身: 无任何变化, 让上层相等短路。
 * - 返回新数组: 末条已 swap。
 * - 返回 `null`: 未命中 (长度不同 / 中间有变化 / 末条非 assistant·reasoning·end),
 *   调用方走原 merge。
 *
 * 仅对末条 assistant / reasoning / end 启用: 这些角色的 [`hydrateToolDisplay`]
 * 是 no-op, 直接复用 live 引用不会丢失 toolDisplay; tool / user 末条仍需走原
 * merge 做 hydrate 与去重。顺序不变是流式追加的前提 ── applyTextChunk 只追加
 * 内容不重排, 故跳过 sort 安全。
 */
export function trySwapLastLiveMessage(
  current: ChatMessage[],
  renderable: ChatMessage[],
): ChatMessage[] | null {
  const len = renderable.length;
  if (len === 0 || len !== current.length) return null;

  // 找第一个引用不同的位置; 全等则返回 current 让上层短路
  let firstDiff = -1;
  for (let i = 0; i < len; i += 1) {
    if (renderable[i] !== current[i]) {
      firstDiff = i;
      break;
    }
  }
  if (firstDiff === -1) return current;
  // 唯一差异必须在末条; 中间有变化 (新增 / 重排 / 历史回放) 走原 merge
  if (firstDiff !== len - 1) return null;

  const currentLast = current[len - 1];
  const renderableLast = renderable[len - 1];
  const role = renderableLast.role;
  if (role !== "assistant" && role !== "reasoning" && role !== "end") return null;
  if (renderableLast.id !== currentLast.id || currentLast.role !== role) {
    return null;
  }

  const merged = current.slice();
  merged[len - 1] = renderableLast;
  return merged;
}

export function prependHistoricalMessages(
  existing: ChatMessage[],
  older: ChatMessage[],
  agentType?: AgentTypeKey,
): ChatMessage[] {
  if (older.length === 0) return existing;
  const hydratedOlder = hydrateHistoricalMessages(older, agentType);
  if (existing.length === 0) return hydratedOlder;
  const seenIds = new Set(existing.map((m) => m.id));
  const fresh = hydratedOlder.filter((m) => !seenIds.has(m.id));
  if (fresh.length === 0) return existing;
  return [...fresh, ...existing];
}
