import type { ChatMessage } from "@/types";
import type { AgentTypeKey, AgentRunState, LastRunSnapshot, AgentRunStatus } from "@/types/agent";
import type { LiveMessageState } from "@features/agent/store/chunk-result";
import { mergeHistoricalMessages } from "@features/agent/store/thread-history";

/**
 * Single per-thread projection derived from the backend AgentEvent stream.
 *
 * 这是 `useAgentSessionStore.threadProjections[threadId]` 持有的形态, 也是
 * `reduceProjection(projection, event) → projection` 唯一接受的 input/output.
 *
 * 派生关系:
 * - 旧 `ChatStore.threadStates[tid]` 的 metadata 字段 (isLoading / activeRunId /
 *   runs / lastRun / oldestSequence / hasMoreHistory / loadingMore) → `runs` 与
 *   `pagination`.
 * - 旧 `ConversationStore.messageStates[tid]` 的 messages / pending ids →
 *   `messages` 与 `pending`.
 * - 旧 `ChatStore.threadStates[tid].messages / pendingAssistantId /
 *   pendingReasoningId` 已被合并到这里, 是单一真源.
 */
export interface ThreadProjection {
  /** 渲染给用户的消息数组 (assistant / reasoning / tool / user). */
  messages: ChatMessage[];
  /** 流式游标 ── 下一条 text/reasoning chunk 应该 append 到哪条消息, 或 null = 开新. */
  pending: {
    assistantId: string | null;
    reasoningId: string | null;
  };
  /** 历史分页 cursor 与并发锁. */
  pagination: {
    oldestSequence: number | null;
    hasMoreHistory: boolean;
    loadingInitial: boolean;
    loadingMore: boolean;
  };
  /** run 生命周期元数据. 与 messages 同生命周期, 但语义独立. */
  runs: {
    isLoading: boolean;
    activeRunId: string | null;
    runs: Record<string, AgentRunState>;
    lastRun?: LastRunSnapshot;
  };
}

export const EMPTY_PENDING = Object.freeze({
  assistantId: null,
  reasoningId: null,
}) as Readonly<ThreadProjection["pending"]>;

export function emptyProjection(): ThreadProjection {
  return {
    messages: [],
    pending: { assistantId: null, reasoningId: null },
    pagination: {
      oldestSequence: null,
      hasMoreHistory: false,
      loadingInitial: false,
      loadingMore: false,
    },
    runs: {
      isLoading: false,
      activeRunId: null,
      runs: {},
    },
  };
}

/**
 * 投影里与 messages 相关的部分 (用于 chunk-reducer 系列函数).
 * LiveMessageState = messages + pending assistant/reasoning id.
 */
export type ProjectionLive = LiveMessageState;

/**
 * 投影里与 runs 相关的部分 (用于 run-lifecycle 系列函数).
 * RunLifecycleThreadState = isLoading + activeRunId + runs + lastRun + pending ids.
 * 注意: pending ids 在 RunLifecycleThreadState 中也存在, 但最终真相是
 * ThreadProjection.pending. 这里抽出 ensuresRun 系列 reducer 仍可被 run-lifecycle
 * 函数复用而不重复实现.
 */
export type ProjectionRuns = ThreadProjection["runs"] & {
  pendingAssistantId: string | null;
  pendingReasoningId: string | null;
};

export function projectionToLive(p: ThreadProjection): ProjectionLive {
  return {
    messages: p.messages,
    pendingAssistantId: p.pending.assistantId,
    pendingReasoningId: p.pending.reasoningId,
  };
}

export function projectionToRuns(p: ThreadProjection): ProjectionRuns {
  return {
    isLoading: p.runs.isLoading,
    activeRunId: p.runs.activeRunId,
    runs: p.runs.runs,
    lastRun: p.runs.lastRun,
    pendingAssistantId: p.pending.assistantId,
    pendingReasoningId: p.pending.reasoningId,
  };
}

export function runsToProjectionRuns(r: ProjectionRuns): ThreadProjection["runs"] {
  return {
    isLoading: r.isLoading,
    activeRunId: r.activeRunId,
    runs: r.runs,
    lastRun: r.lastRun,
  };
}

// --------------------------------------------------------------------
// Run lifecycle helpers (ThreadProjection 适配版)
// --------------------------------------------------------------------

function isTerminalRunStatus(
  status: AgentRunStatus | undefined,
): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

/**
 * 判断 run 是否已终结 ── lastRun 快照匹配 + status 是终态. dispatcher 在派
 * 发 data chunk 时用作 late-chunk guard: 已结束 run 后续 chunk 丢弃, 防止
 * ensureRunActive 复活 run 与 pendingAssistantId=null 碎片化.
 */
export function isProjectionRunEnded(
  p: ThreadProjection,
  runId: string | undefined,
): boolean {
  if (!runId || !p.runs.lastRun) return false;
  return (
    p.runs.lastRun.runId === runId && isTerminalRunStatus(p.runs.lastRun.status)
  );
}

/**
 * 判断 projection 是否处于正在跑的状态 ── isLoading=true + activeRunId 已设
 * + runs[activeRunId].status === "running".
 */
export function isProjectionRunActive(p: ThreadProjection): boolean {
  return (
    p.runs.isLoading &&
    !!p.runs.activeRunId &&
    p.runs.runs[p.runs.activeRunId]?.status === "running"
  );
}

// --------------------------------------------------------------------
// Projection 合并 helper
// --------------------------------------------------------------------

/**
 * 合并两个 ThreadProjection ── 用于 session_resolved 迁移 / reconcile
 * snapshot / local→canonical thread id 切换等场景. 三个调用方原本各自
 * 复制了一份完全相同的合并逻辑, 这里抽成纯函数保证一致行为:
 *
 * - `from` 的 messages 追加到 `to` 的 messages 后, 走 mergeHistoricalMessages
 *   去重 + 排序 (agentType 决定排序方向).
 * - `pending` 字段: 任一非空就用它, 否则 null. to 优先.
 * - `pagination` 字段: oldestSequence 取首个非 null; hasMoreHistory OR; loading
 *   状态取 to 的 (to 是 canonical session, 优先用其 loading 锁).
 * - `runs` 字段: isLoading OR; activeRunId 取首个非 null (to 优先); runs 合并;
 *   lastRun 取首个非 undefined (to 优先).
 *
 * 调用方须保证 at least one of from/to is defined (避免 emptyProjection 噪音).
 */
export function mergeThreadProjections(
  from: ThreadProjection | undefined,
  to: ThreadProjection | undefined,
  agentType: AgentTypeKey,
): ThreadProjection {
  // messages: to 在前, from 在后, 走 mergeHistoricalMessages 做去重 + 排序.
  let mergedMessages = to?.messages ?? [];
  if (from && from.messages.length > 0) {
    mergedMessages = mergeHistoricalMessages(
      mergedMessages,
      from.messages,
      agentType,
    );
  }

  return {
    messages: mergedMessages,
    pending: {
      assistantId:
        to?.pending.assistantId ?? from?.pending.assistantId ?? null,
      reasoningId:
        to?.pending.reasoningId ?? from?.pending.reasoningId ?? null,
    },
    pagination: {
      oldestSequence:
        to?.pagination.oldestSequence ?? from?.pagination.oldestSequence ?? null,
      hasMoreHistory:
        (to?.pagination.hasMoreHistory ?? false) ||
        (from?.pagination.hasMoreHistory ?? false),
      loadingInitial: to?.pagination.loadingInitial ?? false,
      loadingMore: to?.pagination.loadingMore ?? false,
    },
    runs: {
      isLoading:
        (to?.runs.isLoading ?? false) || (from?.runs.isLoading ?? false),
      activeRunId:
        to?.runs.activeRunId ?? from?.runs.activeRunId ?? null,
      runs: {
        ...(to?.runs.runs ?? {}),
        ...(from?.runs.runs ?? {}),
      },
      lastRun: to?.runs.lastRun ?? from?.runs.lastRun,
    },
  };
}