import { useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';

import type {
  AgentConversationInstance,
  AgentConversationStore,
} from '@features/agent/store/agent-conversation-store';
import {
  useAgentSessionStore,
} from '@features/agent/store/agent-session-store';
import type { ThreadProjection } from '@features/agent/store/session-reducer';

const FIELD_SEPARATOR = '';
const EMPTY_FIELD = '-';

export type ConversationRunIndex = Readonly<Record<string, string>>;

export interface ConversationRunSummary {
  status: 'running' | 'completed' | 'failed' | 'cancelled' | null;
  runId: string | null;
  startedAt: number;
  currentTool: string | null;
}

const EMPTY_RUN_SUMMARY: ConversationRunSummary = {
  status: null,
  runId: null,
  startedAt: 0,
  currentTool: null,
};

function runSignature(projection: ThreadProjection | undefined): string {
  if (!projection) return EMPTY_FIELD;
  const runs = projection.runs;
  const activeRun = runs.activeRunId ? runs.runs[runs.activeRunId] : undefined;
  const status = activeRun?.status ?? runs.lastRun?.status ?? EMPTY_FIELD;
  const runId = activeRun?.runId ?? runs.lastRun?.runId ?? EMPTY_FIELD;
  const startedAt = activeRun?.startedAt ?? runs.lastRun?.startedAt ?? 0;
  const currentTool = activeRun?.currentTool ?? EMPTY_FIELD;
  return `${status}${FIELD_SEPARATOR}${runId}${FIELD_SEPARATOR}${startedAt}${FIELD_SEPARATOR}${currentTool}`;
}

function uniqueThreadIds(instances: Record<string, AgentConversationInstance>): string[] {
  const ids = new Set<string>();
  for (const instance of Object.values(instances)) {
    if (instance.threadId) ids.add(instance.threadId);
  }
  return [...ids].sort();
}

export function buildConversationRunIndex(
  projections: Record<string, ThreadProjection>,
  threadIds: readonly string[],
): ConversationRunIndex {
  const index: Record<string, string> = {};
  for (const threadId of threadIds) {
    index[threadId] = runSignature(projections[threadId]);
  }
  return index;
}

/**
 * Subscribe only to run-lifecycle fields for the supplied conversations.
 * Text/reasoning/tool deltas may replace `threadProjections`, but the shallow
 * map remains referentially stable while status/run id/start time are unchanged.
 */
export function useConversationRunIndex(
  instances: Record<string, AgentConversationInstance>,
): ConversationRunIndex {
  const threadIds = useMemo(() => uniqueThreadIds(instances), [instances]);
  const selector = useCallback(
    (state: ReturnType<typeof useAgentSessionStore.getState>) => (
      buildConversationRunIndex(state.threadProjections, threadIds)
    ),
    [threadIds],
  );
  // Phase 4 (2026-08-02): 真源切到 session-store.threadProjections. 旧
  // chat-store.threadStates 经 mirror 同步, 但这里直接读真源.
  return useAgentSessionStore(useShallow(selector));
}

export function getConversationRunSummary(
  index: ConversationRunIndex,
  threadId: string | null | undefined,
): ConversationRunSummary {
  if (!threadId) return EMPTY_RUN_SUMMARY;
  const signature = index[threadId];
  if (!signature || signature === EMPTY_FIELD) return EMPTY_RUN_SUMMARY;
  const [status, runId, startedAt, currentTool] = signature.split(FIELD_SEPARATOR);
  return {
    status: status === EMPTY_FIELD
      ? null
      : status as ConversationRunSummary['status'],
    runId: runId === EMPTY_FIELD ? null : runId,
    startedAt: Number(startedAt) || 0,
    currentTool: currentTool === EMPTY_FIELD ? null : currentTool,
  };
}

export function isAgentConversationRunning(
  instance: AgentConversationInstance | null | undefined,
  index: ConversationRunIndex,
): boolean {
  return getConversationRunSummary(index, instance?.threadId).status === 'running';
}

export function selectRunningAgentConversations(
  state: Pick<AgentConversationStore, 'instances'>,
  index: ConversationRunIndex,
): AgentConversationInstance[] {
  return Object.values(state.instances)
    .filter((instance) => isAgentConversationRunning(instance, index))
    .sort((a, b) => (
      getConversationRunSummary(index, a.threadId).startedAt
      - getConversationRunSummary(index, b.threadId).startedAt
    ));
}
