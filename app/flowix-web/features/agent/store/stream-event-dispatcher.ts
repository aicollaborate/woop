import type { AgentEvent } from "@/types/agent";
import { getAgentType } from "@/lib/agent-types";
import { recordAgentLifecycleEvent } from "@features/agent/diagnostics/agent-run-trace";
import { useAgentSessionStore } from "@features/agent/store/agent-session-store";
import {
  emptyProjection,
  isProjectionRunActive,
  isProjectionRunEnded,
  mergeThreadProjections,
} from "@features/agent/store/session-reducer";
import {
  createStreamingBuffer,
  type StreamingBufferSnapshot,
} from "@features/agent/store/streaming-buffer";
import { syncConversationInstanceForEvent } from "@features/agent/store/conversation-run-sync";

/**
 * `stream-event-dispatcher` 重构版 ── 单一写源 `useAgentSessionStore`.
 *
 * 历史: 旧实现经 `host.applyPatch` 写 chat-store, 同时直接调
 * `useAgentConversationStore.syncLiveMessageState` 写 conv-store, 形成双写.
 * 本文件仅做 orchestration: late chunk guard / ensureRunActive / buffering /
 * session_resolved migration ── 单一 dispatch 落到 session store 的
 * `threadProjections[tid]`, 老 store 由 subscribe 镜像 (后续 PR).
 *
 * 涉及模块边界 (2026-08-02):
 * - session-reducer: 纯 reducer (`reduceProjection(projection, event) → projection`).
 * - agent-session-store: 单一 zustand, 三 sub-projection, dispatch 入口.
 * - chat-store / agent-conversation-store: 暂时保留 actions; 通过镜像订阅
 *   跟随 session store, 6 个月分期最终删除.
 */

export interface StreamEventDispatcher {
  /**
   * 派发一个 AgentEvent。 text / reasoning 走 rAF 缓冲, 其它事件同步 flush
   * 后再走 reducer。 session_resolved 还会清空 streamingBuffer 以避免悬空
   * 缓冲写错 thread id。
   */
  dispatch(event: AgentEvent): void;
  /** 同步 flush 当前 buffered text/reasoning chunk ── 给 stopThreadRun 用。 */
  flushBuffer(): void;
}

// --------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------

/**
 * 是否为承载消息内容的 data chunk ── 这些 chunk 若在一个已终结 run 之后到达
 * (late chunk), 会被 dispatch 顶部 guard 丢弃, 防止 ensureRunActive 复活 run
 * 与 pendingAssistantId=null 导致的新建消息碎片化。
 */
function isDataChunk(kind: AgentEvent["kind"]): boolean {
  return (
    kind === "text_delta" ||
    kind === "user_message" ||
    kind === "reasoning_delta" ||
    kind === "final_message" ||
    kind === "tool_call" ||
    kind === "tool_result"
  );
}

/**
 * 哪些 event 表明 thread 已经处于 "应当 active" 但 projection 还没记录
 * stream_start 的状态 ── 这种情况下 dispatcher 补丁式合成一个 stream_start
 * event, 通过 `useAgentSessionStore.dispatch` 应用, 然后 dispatch 原 event.
 */
function shouldEnsureRunActive(event: AgentEvent): boolean {
  return (
    event.kind === "text_delta" ||
    event.kind === "final_message" ||
    event.kind === "reasoning_delta" ||
    event.kind === "tool_call" ||
    event.kind === "tool_result"
  );
}

function synthesizeStreamStart(event: AgentEvent): AgentEvent & {
  kind: "stream_start";
} {
  return {
    kind: "stream_start",
    agentType: event.agentType,
    threadId: event.threadId,
    runId: event.runId ?? `${event.threadId}-synthetic`,
    timestamp: event.timestamp,
  };
}

// --------------------------------------------------------------------
// session_resolved ── 跨 thread 合并 projection + 更新 sessionMeta
// --------------------------------------------------------------------

function applySessionResolved(
  event: AgentEvent & { kind: "session_resolved" },
): void {
  const tid = event.threadId;
  const sessionId = event.sessionId;
  if (!sessionId || sessionId === tid) return;

  const session = useAgentSessionStore.getState();
  const fromProjection = session.threadProjections[tid];
  const toProjection = session.threadProjections[sessionId];

  // 合并 projection ── 抽到 session-reducer/mergeThreadProjections.
  // 任一边缺失都按另一边兜底, 都没则跳过 (emptyProjection 噪音).
  if (toProjection || fromProjection) {
    const merged = mergeThreadProjections(
      fromProjection,
      toProjection,
      event.agentType,
    );
    session.setThreadProjection(sessionId, () => merged);
    session.removeThreadProjection(tid);
  }

  session.setSessionMeta((meta) => ({
    ...meta,
    threadTypes: {
      ...meta.threadTypes,
      [tid]: event.agentType,
      [sessionId]: event.agentType,
    },
    externalSessionResolutions: {
      ...meta.externalSessionResolutions,
      [tid]: sessionId,
    },
    activeThreadIds: {
      ...meta.activeThreadIds,
      [event.agentType]: sessionId,
    },
    activeAgentTypeKey: event.agentType,
  }));
}

// --------------------------------------------------------------------
// dispatcher factory
// --------------------------------------------------------------------

export function createStreamEventDispatcher(): StreamEventDispatcher {
  const streamingBuffer = createStreamingBuffer(
    (
      textSnapshot: StreamingBufferSnapshot,
      reasoningSnapshot: StreamingBufferSnapshot,
    ) => {
      const session = useAgentSessionStore.getState();
      const now = Date.now();
      // reasoning 先 apply ── 与旧 store 时序一致 (reasoning chunk 先于
      // text 出现; text chunk 落地时会 close reasoning 行).
      for (const [tid, text] of reasoningSnapshot) {
        const current = session.threadProjections[tid];
        if (!current || !current.runs.activeRunId) continue;
        const agentType = getAgentType(
          session.sessionMeta.threadTypes[tid] ?? session.sessionMeta.activeAgentTypeKey,
        ).key;
        session.dispatch({
          kind: "reasoning_delta",
          agentType,
          threadId: tid,
          runId: current.runs.activeRunId,
          timestamp: now,
          text,
          messagePhase: "updated",
          contentMode: "delta",
          sourceTimestamp: now,
        });
      }
      for (const [tid, text] of textSnapshot) {
        const current = session.threadProjections[tid];
        if (!current || !current.runs.activeRunId) continue;
        const agentType = getAgentType(
          session.sessionMeta.threadTypes[tid] ?? session.sessionMeta.activeAgentTypeKey,
        ).key;
        session.dispatch({
          kind: "text_delta",
          agentType,
          threadId: tid,
          runId: current.runs.activeRunId,
          timestamp: now,
          text,
          messagePhase: "updated",
          contentMode: "delta",
          sourceTimestamp: now,
        });
      }
    },
  );

  function dispatch(event: AgentEvent): void {
    const session = useAgentSessionStore.getState();
    const current =
      session.threadProjections[event.threadId] ?? emptyProjection();

    recordAgentLifecycleEvent(event, {
      activeRunId: current.runs.activeRunId,
      isLoading: current.runs.isLoading,
    });

    // Late chunk guard: data chunk 到达已终结 run 时丢弃.
    if (isDataChunk(event.kind) && isProjectionRunEnded(current, event.runId)) {
      return;
    }

    // session_resolved 是跨 thread 合并, 不进单 projection dispatch.
    if (event.kind === "session_resolved") {
      streamingBuffer.flushSync();
      syncConversationInstanceForEvent(event);
      applySessionResolved(event);
      return;
    }

    // ensureRunActive: data chunk 但 projection 还不是 running 状态.
    if (shouldEnsureRunActive(event) && !isProjectionRunActive(current)) {
      session.dispatch(synthesizeStreamStart(event));
    }

    // text / reasoning 走 rAF 缓冲.
    switch (event.kind) {
      case "text_delta": {
        if (!event.text || !event.text.trim()) return;
        if (
          event.messageId ||
          event.contentMode === "snapshot" ||
          // Legacy Claude envelope ids are intentionally removed by the
          // mapper. Apply their ordered deltas synchronously so source order
          // metadata survives database replay and tool boundaries.
          event.sourceSequence !== undefined
        ) {
          streamingBuffer.flushSync();
          session.dispatch(event);
          return;
        }
        streamingBuffer.appendText(event.threadId, event.text);
        return;
      }
      case "reasoning_delta": {
        if (event.messageId || event.contentMode === "snapshot") {
          streamingBuffer.flushSync();
          session.dispatch(event);
          return;
        }
        streamingBuffer.appendReasoning(event.threadId, event.text);
        return;
      }
      case "final_message":
      case "tool_call":
      case "tool_result":
      case "error":
      case "stream_end":
        // 这些 chunk 频率低且必须立刻可见, 不走节流; 但必须先 flush 缓冲.
        streamingBuffer.flushSync();
        break;
      case "stream_start":
      case "usage":
        // stream_start / usage 无需 flush.
        break;
      case "user_message":
        streamingBuffer.flushSync();
        break;
    }

    if (event.kind !== "usage") {
      syncConversationInstanceForEvent(event);
    }

    session.dispatch(event);
  }

  return {
    dispatch,
    flushBuffer: () => streamingBuffer.flushSync(),
  };
}