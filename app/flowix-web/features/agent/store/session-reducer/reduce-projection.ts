import type { AgentEvent } from "@/types/agent";
import {
  applyErrorChunk,
  applyReasoningChunk,
  applyTextChunk,
  applyUserMessageChunk,
} from "@features/agent/store/message-chunks";
import {
  applyToolCallChunk,
  applyToolResultChunk,
} from "@features/agent/store/tool-chunks";
import {
  applyRunEnded,
  applyRunFailed,
  applyRunStarted,
  applyRunToolState,
  applyRunUsage,
} from "@features/agent/store/run-lifecycle";
import { closeLoadingToolRows } from "@features/agent/store/thread-runtime-state";
import {
  emptyProjection,
  projectionToLive,
  projectionToRuns,
  runsToProjectionRuns,
  type ThreadProjection,
} from "@features/agent/store/session-reducer/types";

/**
 * 单一 reducer 入口: (projection, event) → projection.
 *
 * 纯函数, 无副作用, 不读外部 store. 这是双写修复的核心 ── dispatch
 * 时调一次, 一次 setState 落到 AgentSessionStore, 不再调 conv-store 与
 * chat-store 各一次.
 *
 * 实现策略:
 * - 复用现有 chunk-reducer / run-lifecycle reducer (已经是纯函数).
 * - 投影 → LiveMessageState 与 ProjectionRuns 仅作为 adapter, 让旧 reducer
 *   无需重写.
 * - 各 case 处理 event.kind → 调用合适 reducer → 合并回 ThreadProjection.
 */
export function reduceProjection(
  projection: ThreadProjection,
  event: AgentEvent,
): ThreadProjection {
  switch (event.kind) {
    case "user_message":
      return applyUserMessageToProjection(projection, event);
    case "text_delta":
      return applyTextDeltaToProjection(projection, event);
    case "reasoning_delta":
      return applyReasoningDeltaToProjection(projection, event);
    case "final_message":
      return applyFinalMessageToProjection(projection, event);
    case "tool_call":
      return applyToolCallToProjection(projection, event);
    case "tool_result":
      return applyToolResultToProjection(projection, event);
    case "stream_start":
      return applyStreamStartToProjection(projection, event);
    case "stream_end":
      return applyStreamEndToProjection(projection, event);
    case "error":
      return applyErrorToProjection(projection, event);
    case "usage":
      return applyUsageToProjection(projection, event);
    case "session_resolved":
      // session_resolved 不属于本投影的语义 ── 由外部协调 (applyExternalSessionResolved)
      // 跨 thread 合并两 projection. reducer 这层不做, 直接返回.
      return projection;
    default:
      return projection;
  }
}

// --------------------------------------------------------------------
// 各 case 实现
// --------------------------------------------------------------------

function applyUserMessageToProjection(
  p: ThreadProjection,
  event: AgentEvent & { kind: "user_message" },
): ThreadProjection {
  const live = projectionToLive(p);
  const next = applyUserMessageChunk(live, event.text, {
    id: event.id,
    phase: "completed",
    contentMode: "snapshot",
    sourceTimestamp: event.sourceTimestamp,
    sourceSequence: event.sourceSequence,
    sourceSubsequence: event.sourceSubsequence,
  });
  return {
    ...p,
    messages: next.messages,
    pending: {
      assistantId: next.pendingAssistantId,
      reasoningId: next.pendingReasoningId,
    },
  };
}

function applyTextDeltaToProjection(
  p: ThreadProjection,
  event: AgentEvent & { kind: "text_delta" },
): ThreadProjection {
  const live = projectionToLive(p);
  const next = applyTextChunk(live, event.text, {
    id: event.messageId,
    phase: event.messagePhase,
    contentMode: event.contentMode,
    sourceTimestamp: event.sourceTimestamp,
    sourceSequence: event.sourceSequence,
    sourceSubsequence: event.sourceSubsequence,
  });
  // text 落地后 reasoning 行 closed (applyTextChunk 已把 reasoning isCompleted=true).
  // run-level state: 当前 tool 名清空 (新文本流开始).
  const runsNext = applyRunToolState(projectionToRuns(p), event, null);
  return {
    ...p,
    messages: next.messages,
    pending: {
      assistantId: next.pendingAssistantId,
      reasoningId: next.pendingReasoningId,
    },
    runs: runsToProjectionRuns(runsNext),
  };
}

function applyReasoningDeltaToProjection(
  p: ThreadProjection,
  event: AgentEvent & { kind: "reasoning_delta" },
): ThreadProjection {
  const live = projectionToLive(p);
  const next = applyReasoningChunk(live, event.text, {
    id: event.messageId,
    phase: event.messagePhase,
    contentMode: event.contentMode,
    sourceTimestamp: event.sourceTimestamp,
    sourceSequence: event.sourceSequence,
    sourceSubsequence: event.sourceSubsequence,
  });
  return {
    ...p,
    messages: next.messages,
    pending: {
      assistantId: next.pendingAssistantId,
      reasoningId: next.pendingReasoningId,
    },
  };
}

function applyFinalMessageToProjection(
  p: ThreadProjection,
  event: AgentEvent & { kind: "final_message" },
): ThreadProjection {
  // final_message 形态与 text_delta 一致, 仅 contentMode="snapshot" 且 phase="completed".
  const live = projectionToLive(p);
  const next = applyTextChunk(live, event.text, {
    id: event.messageId,
    phase: event.messagePhase,
    contentMode: event.contentMode,
    sourceTimestamp: event.sourceTimestamp,
    sourceSequence: event.sourceSequence,
    sourceSubsequence: event.sourceSubsequence,
  });
  const runsNext = applyRunToolState(projectionToRuns(p), event, null);
  return {
    ...p,
    messages: next.messages,
    pending: {
      assistantId: next.pendingAssistantId,
      reasoningId: next.pendingReasoningId,
    },
    runs: runsToProjectionRuns(runsNext),
  };
}

function applyToolCallToProjection(
  p: ThreadProjection,
  event: AgentEvent & { kind: "tool_call" },
): ThreadProjection {
  const live = projectionToLive(p);
  const next = applyToolCallChunk(
    live,
    event.toolCallId,
    event.name,
    event.input,
    event.agentType,
    event.display,
    {
      id: event.messageId,
      phase: event.messagePhase,
      sourceTimestamp: event.sourceTimestamp,
      sourceSequence: event.sourceSequence,
      sourceSubsequence: event.sourceSubsequence,
    },
  );
  // tool_call 是流中断点 ── 清 pendingAssistantId, 记录当前 tool 名到 run.
  const runsNext = applyRunToolState(projectionToRuns(p), event, event.name);
  return {
    ...p,
    messages: next.messages,
    pending: {
      assistantId: next.pendingAssistantId,
      reasoningId: p.pending.reasoningId,
    },
    runs: runsToProjectionRuns(runsNext),
  };
}

function applyToolResultToProjection(
  p: ThreadProjection,
  event: AgentEvent & { kind: "tool_result" },
): ThreadProjection {
  const live = projectionToLive(p);
  const next = applyToolResultChunk(
    live,
    event.toolCallId,
    event.name,
    event.result,
    event.agentType,
    {
      id: event.messageId,
      phase: event.messagePhase,
      sourceTimestamp: event.sourceTimestamp,
      sourceSequence: event.sourceSequence,
      sourceSubsequence: event.sourceSubsequence,
    },
  );
  // tool_result 关闭 tool_call: currentTool 清空 (result 抵达后流回归 assistant 文本).
  const runsNext = applyRunToolState(projectionToRuns(p), event, null);
  return {
    ...p,
    messages: next.messages,
    runs: runsToProjectionRuns(runsNext),
  };
}

function applyStreamStartToProjection(
  p: ThreadProjection,
  event: AgentEvent & { kind: "stream_start" },
): ThreadProjection {
  const runsNext = applyRunStarted(projectionToRuns(p), event, {
    model: event.model,
    modelId: event.model,
    lastRunAt: event.timestamp,
    reasoning_effort: event.reasoning_effort,
  });
  return {
    ...p,
    runs: runsToProjectionRuns(runsNext),
  };
}

function applyStreamEndToProjection(
  p: ThreadProjection,
  event: AgentEvent & { kind: "stream_end" },
): ThreadProjection {
  const runsNext = applyRunEnded(projectionToRuns(p), event);
  // run 结束时把仍 loading 的 tool 行收尾为 isLoading=false (避免中断 tool 永久转圈);
  // 若还有 pending reasoning, 同步把它收尾为 isCompleted=true. 这两条收尾独立但都
  // 仅在 run 真正结束 (!runsNext.isLoading) 时触发, 避免误关并发 run 的消息.
  const terminalMessages = !runsNext.isLoading
    ? closeLoadingToolRows(
        p.pending.reasoningId
          ? p.messages.map((m) =>
              m.id === p.pending.reasoningId && m.role === "reasoning"
                ? { ...m, isCompleted: true }
                : m,
            )
          : p.messages,
      )
    : p.messages;
  return {
    ...p,
    messages: terminalMessages,
    pending: {
      assistantId: runsNext.isLoading ? p.pending.assistantId : null,
      reasoningId: runsNext.isLoading ? p.pending.reasoningId : null,
    },
    runs: runsToProjectionRuns(runsNext),
  };
}

function applyErrorToProjection(
  p: ThreadProjection,
  event: AgentEvent & { kind: "error" },
): ThreadProjection {
  const live = projectionToLive(p);
  const next = applyErrorChunk(live, event.message);
  const runsNext = applyRunFailed(projectionToRuns(p), event, event.message);
  // pending ids 跟随 run 失败 (applyRunFailed 已清, 但保险起见再次覆盖).
  return {
    ...p,
    messages: next.messages,
    pending: {
      assistantId: runsNext.pendingAssistantId,
      reasoningId: runsNext.pendingReasoningId,
    },
    runs: runsToProjectionRuns(runsNext),
  };
}

function applyUsageToProjection(
  p: ThreadProjection,
  event: AgentEvent & { kind: "usage" },
): ThreadProjection {
  const runsNext = applyRunUsage(projectionToRuns(p), event);
  return {
    ...p,
    runs: runsToProjectionRuns(runsNext),
  };
}

// --------------------------------------------------------------------
// helpers ── 重新导出以便外部测试
// --------------------------------------------------------------------

export { emptyProjection };