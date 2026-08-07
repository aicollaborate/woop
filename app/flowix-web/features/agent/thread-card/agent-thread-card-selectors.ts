import type { AgentRunState, AgentTypeKey } from '@/types/agent';
import type { ThreadState } from '@features/agent/store/thread-runtime-state';
import { getAgentType } from '@/lib/agent-types';

export interface AgentThreadCardRunStatusView {
  activeRun: AgentRunState | undefined;
  latestRun: AgentRunState | undefined;
  supportsStreaming: boolean;
  isIdle: boolean;
  status: AgentRunState['status'] | 'completed';
  statusClass: AgentRunState['status'] | 'completed' | 'idle';
  shouldShowStatus: boolean;
}

export interface AgentThreadCardRuntimeView extends AgentThreadCardRunStatusView {
  isRunning: boolean;
  isBusy: boolean;
  showLoadingIndicator: boolean;
  sendButtonWantsStop: boolean;
}

export function selectAgentThreadCardRunStatus(input: {
  state: ThreadState | undefined;
  isCreating: boolean;
  isLoading: boolean;
  typeKey: AgentTypeKey;
}): AgentThreadCardRunStatusView {
  const activeRun = input.state?.activeRunId
    ? input.state.runs[input.state.activeRunId]
    : undefined;
  const latestThreadRun = activeRun ?? Object.values(input.state?.runs ?? {})
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  const latestRun = latestThreadRun;
  const supportsStreaming = getAgentType(activeRun?.agentType ?? input.typeKey)
    .capabilities.supportsTextStreaming;
  const isIdle = !input.isCreating && !activeRun && !input.isLoading && !latestRun;
  const status = input.isCreating
    ? 'running'
    : activeRun?.status ??
      (input.isLoading ? 'running' : latestThreadRun?.status ?? 'completed');

  return {
    activeRun,
    latestRun,
    supportsStreaming,
    isIdle,
    status,
    statusClass: isIdle ? 'idle' : status,
    shouldShowStatus: !isIdle,
  };
}

export function selectAgentThreadCardRuntimeView(input: {
  state: ThreadState | undefined;
  isCreating: boolean;
  isLoading: boolean;
  typeKey: AgentTypeKey;
}): AgentThreadCardRuntimeView {
  const statusView = selectAgentThreadCardRunStatus(input);
  const activeRun = statusView.activeRun;
  // `state.isLoading` is the canonical lifecycle signal. During the short
  // window between stream_start and the run registry update, activeRunId can
  // already be set while `activeRun` is still unavailable. Dropping this
  // fallback makes the renderer leave its rAF streaming path and can rebuild
  // the whole message list through an intermediate empty projection.
  const isRunning = input.isLoading || activeRun?.status === 'running';
  const isBusy = input.isCreating || isRunning;
  /*
   * 工具调用阶段的 loader:
   * run 状态为 "running" 时(纯文本/推理流)显然要显示; 但 provider 通常
   * 在发出 tool_call 后立刻 stream_end,导致 run 状态变成 "completed" 而
   * tool 仍在外部执行。此时 store 侧仍有 activeRunId / currentTool /
   * 处于 isLoading 的 tool 行 — 任何一条成立都说明 agent 还在工作,应该
   * 把 loading-indicator 继续显示,而不是隐藏到下一轮 stream_start。
   */
  const hasInFlightTool = !!activeRun?.currentTool;
  const hasLoadingToolRow = (input.state?.messages ?? []).some(
    (m) => m.role === 'tool' && m.isLoading,
  );
  const showLoadingIndicator =
    isRunning || hasInFlightTool || hasLoadingToolRow;
  return {
    ...statusView,
    isRunning,
    isBusy,
    showLoadingIndicator,
    sendButtonWantsStop: isRunning,
  };
}

export function selectAgentThreadCardSendButtonState(input: {
  wantStop: boolean;
  inputValue: string;
  hasAttachments?: boolean;
  hasPendingAttachments?: boolean;
}): { wantStop: boolean; disabled: boolean } {
  const hasInput = !!input.inputValue.trim() || !!input.hasAttachments;
  return {
    wantStop: input.wantStop,
    disabled: !input.wantStop && (!hasInput || !!input.hasPendingAttachments),
  };
}
