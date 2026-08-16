import type {
  AgentEvent,
  AgentRunState,
  LastRunSnapshot,
  StatusInfo,
  UsageInfo,
} from "@/types/agent";

export const USER_STOPPED_REASON = "user_stopped";

export interface RunLifecycleThreadState {
  isLoading: boolean;
  activeRunId: string | null;
  runs: Record<string, AgentRunState>;
  pendingAssistantId: string | null;
  pendingReasoningId: string | null;
  lastRun?: LastRunSnapshot;
}

function upsertRun(
  st: RunLifecycleThreadState,
  event: AgentEvent,
  status: AgentRunState["status"],
  extra: Partial<AgentRunState> = {},
): Record<string, AgentRunState> {
  const existing = st.runs[event.runId];
  return {
    ...st.runs,
    [event.runId]: {
      ...existing,
      runId: event.runId,
      agentType: event.agentType,
      threadId: event.threadId,
      startedAt: existing?.startedAt ?? event.timestamp,
      status,
      ...extra,
    },
  };
}

function keepRunningRuns(
  runs: Record<string, AgentRunState>,
  removeRunId?: string,
): Record<string, AgentRunState> {
  return Object.fromEntries(
    Object.entries(runs).filter(([runId, run]) => {
      if (runId === removeRunId) return false;
      return run.status === "running";
    }),
  ) as Record<string, AgentRunState>;
}

function snapshotFromRun(
  run: AgentRunState,
  status: AgentRunState["status"],
  reason: string | null | undefined,
): LastRunSnapshot {
  return {
    runId: run.runId,
    agentType: run.agentType,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    model: run.model,
    modelId: run.modelId,
    lastRunAt: run.lastRunAt,
    usage: run.usage,
    statusInfo: run.statusInfo,
    status,
    reason,
  };
}

function accumulateUsage(previous: UsageInfo | undefined, next: UsageInfo): UsageInfo {
  return {
    input_tokens: (previous?.input_tokens ?? 0) + (next.input_tokens ?? 0),
    cached_input_tokens:
      (previous?.cached_input_tokens ?? 0) + (next.cached_input_tokens ?? 0),
    output_tokens: (previous?.output_tokens ?? 0) + (next.output_tokens ?? 0),
    reasoning_output_tokens:
      (previous?.reasoning_output_tokens ?? 0) +
      (next.reasoning_output_tokens ?? 0),
    total_tokens: (previous?.total_tokens ?? 0) + (next.total_tokens ?? 0),
    model_context_window:
      next.model_context_window ?? previous?.model_context_window,
    context_used_tokens:
      next.context_used_tokens ?? previous?.context_used_tokens,
  };
}

export function applyRunStarted<T extends RunLifecycleThreadState>(
  st: T,
  event: AgentEvent,
  extra: Partial<AgentRunState> = {},
): T {
  const nextRuns = upsertRun(st, event, "running", extra);
  return {
    ...st,
    isLoading: true,
    activeRunId: event.runId,
    runs: nextRuns,
  };
}

export function applyRunToolState<T extends RunLifecycleThreadState>(
  st: T,
  event: AgentEvent,
  currentTool: string | null,
): T {
  return {
    ...st,
    runs: upsertRun(st, event, "running", { currentTool }),
  };
}

export function applyRunFailed<T extends RunLifecycleThreadState>(
  st: T,
  event: AgentEvent,
  reason: string,
): T {
  const nextRuns = upsertRun(st, event, "failed", {
    endedAt: event.timestamp,
    reason,
  });
  const run = nextRuns[event.runId];
  const isActiveRunFailure = st.activeRunId === event.runId;
  return {
    ...st,
    runs: keepRunningRuns(nextRuns, event.runId),
    lastRun: snapshotFromRun(run, "failed", reason),
    isLoading: isActiveRunFailure ? false : st.isLoading,
    activeRunId: isActiveRunFailure ? null : st.activeRunId,
    pendingAssistantId: null,
    pendingReasoningId: null,
  };
}

export function applyRunStopped<T extends RunLifecycleThreadState>(
  st: T,
  runId: string,
  endedAt: number,
): T {
  const existing = st.runs[runId];
  if (!existing) return st;
  const cancelledRun: AgentRunState = {
    ...existing,
    status: "cancelled",
    reason: existing.reason ?? "cancelled",
    endedAt,
    currentTool: null,
  };
  return {
    ...st,
    isLoading: st.activeRunId === runId ? false : st.isLoading,
    activeRunId: st.activeRunId === runId ? null : st.activeRunId,
    runs: keepRunningRuns(st.runs, runId),
    lastRun: cancelledRun,
    pendingAssistantId: null,
    pendingReasoningId: null,
  };
}

export function applyRunUsage<T extends RunLifecycleThreadState>(
  st: T,
  event: AgentEvent & { kind: "usage" },
): T {
  const existing = st.runs[event.runId];
  const evUsage: UsageInfo = event.usage ?? {};

  // Some providers emit usage after stream_end. The run has already been
  // removed from `runs` at that point, so fold the late event into the
  // session-resident lastRun snapshot instead of dropping it.
  if (!existing) {
    if (st.lastRun?.runId !== event.runId) return st;
    return {
      ...st,
      lastRun: {
        ...st.lastRun,
        usage: accumulateUsage(st.lastRun.usage, evUsage),
        statusInfo: event.statusInfo ?? st.lastRun.statusInfo,
        modelId: event.modelId ?? st.lastRun.modelId,
        lastRunAt: event.lastRunAt ?? st.lastRun.lastRunAt ?? event.timestamp,
      },
    };
  }

  const nextUsage = accumulateUsage(existing.usage, evUsage);
  const nextStatusInfo: StatusInfo | undefined =
    event.statusInfo ?? existing.statusInfo;
  const updatedRun: AgentRunState = {
    ...existing,
    usage: nextUsage,
    statusInfo: nextStatusInfo,
    modelId: event.modelId ?? existing.modelId,
    lastRunAt: event.lastRunAt ?? existing.lastRunAt ?? event.timestamp,
  };
  const shouldUpdateLastRun = st.lastRun?.runId === event.runId;
  return {
    ...st,
    runs: {
      ...st.runs,
      [event.runId]: updatedRun,
    },
    lastRun: shouldUpdateLastRun
      ? {
          ...st.lastRun,
          usage: nextUsage,
          statusInfo: nextStatusInfo,
          modelId: event.modelId ?? st.lastRun?.modelId,
          lastRunAt: event.lastRunAt ?? st.lastRun?.lastRunAt ?? event.timestamp,
        }
      : st.lastRun,
  };
}

export function applyRunEnded<T extends RunLifecycleThreadState>(
  st: T,
  event: AgentEvent & { kind: "stream_end"; reason: string | null },
): T {
  const eventMatchesLastRun = st.lastRun?.runId === event.runId;
  const effectiveRunId =
    st.activeRunId && !st.runs[event.runId] && !eventMatchesLastRun
      ? st.activeRunId
      : event.runId;
  const matchingLastRun =
    st.lastRun?.runId === effectiveRunId ? st.lastRun : undefined;
  const existingStatus = st.runs[effectiveRunId]?.status ?? matchingLastRun?.status;
  const isActiveRunEnd = !st.activeRunId || st.activeRunId === effectiveRunId;
  const isUserStop = event.reason === USER_STOPPED_REASON;
  const status: AgentRunState["status"] =
    existingStatus === "cancelled" || isUserStop
      ? "cancelled"
      : event.reason
        ? "failed"
        : "completed";
  const baseRun: AgentRunState = st.runs[effectiveRunId] ?? {
    runId: effectiveRunId,
    agentType: event.agentType,
    threadId: event.threadId,
    startedAt: matchingLastRun?.startedAt ?? event.timestamp,
    status,
    model: matchingLastRun?.model,
    modelId: matchingLastRun?.modelId,
    lastRunAt: matchingLastRun?.lastRunAt ?? event.timestamp,
    usage: matchingLastRun?.usage,
    statusInfo: matchingLastRun?.statusInfo,
  };
  const finalRun: AgentRunState = {
    ...baseRun,
    status,
    endedAt: event.timestamp,
    reason: event.reason,
  };
  return {
    ...st,
    isLoading: isActiveRunEnd ? false : st.isLoading,
    activeRunId: isActiveRunEnd ? null : st.activeRunId,
    runs: keepRunningRuns(st.runs, effectiveRunId),
    lastRun: snapshotFromRun(finalRun, status, event.reason),
    pendingAssistantId: isActiveRunEnd ? null : st.pendingAssistantId,
    pendingReasoningId: isActiveRunEnd ? null : st.pendingReasoningId,
  };
}
