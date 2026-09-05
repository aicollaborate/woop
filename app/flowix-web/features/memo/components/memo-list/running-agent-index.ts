import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';

import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import {
  buildConversationRunIndex,
  type ConversationRunIndex,
  selectRunningAgentConversations,
} from '@features/agent/store/conversation-run-index';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import type { MemoItem } from '@/types/memo-item';

type RankedAgent = {
  instance: AgentConversationInstance;
  order: number;
};

export type RunningAgentIndex = {
  byMemoId: Map<string, RankedAgent>;
  byThreadId: Map<string, RankedAgent>;
};

const TYPE_INDEX_SEPARATOR = '\u001f';

type RunningAgentTypeMatch = {
  agentType: AgentConversationInstance['agentType'];
  order: number;
};

/**
 * A render-facing projection of running agents. Values are encoded strings so
 * Zustand's shallow equality can compare the flat result by value: changes to
 * an instance title, message projection, or other unrelated agent metadata do
 * not make MemoList render again.
 */
export type RunningAgentTypeIndex = Readonly<Record<string, string>>;

function memoIndexKey(memoId: string): string {
  return `memo:${memoId}`;
}

function threadIndexKey(threadId: string): string {
  return `thread:${threadId}`;
}

function encodeTypeMatch(match: RunningAgentTypeMatch): string {
  return `${match.order}${TYPE_INDEX_SEPARATOR}${match.agentType}`;
}

function decodeTypeMatch(value: string | undefined): RunningAgentTypeMatch | null {
  if (!value) return null;
  const separator = value.indexOf(TYPE_INDEX_SEPARATOR);
  if (separator < 0) return null;
  const order = Number(value.slice(0, separator));
  const agentType = value.slice(separator + TYPE_INDEX_SEPARATOR.length);
  if (!Number.isFinite(order) || !agentType) return null;
  return { agentType: agentType as AgentConversationInstance['agentType'], order };
}

/** Index running agents once, keeping the existing list-order priority. */
export function buildRunningAgentIndex(
  instances: readonly AgentConversationInstance[],
): RunningAgentIndex {
  const byMemoId = new Map<string, RankedAgent>();
  const byThreadId = new Map<string, RankedAgent>();

  instances.forEach((instance, order) => {
    const ranked = { instance, order };
    const memoId = instance.source.memoId;
    if (memoId && !byMemoId.has(memoId)) byMemoId.set(memoId, ranked);

    const threadId = instance.threadId;
    if (threadId && !byThreadId.has(threadId)) byThreadId.set(threadId, ranked);
  });

  return { byMemoId, byThreadId };
}

/** Build the minimal lookup consumed by MemoCard from already-running agents. */
export function buildRunningAgentTypeIndex(
  instances: readonly AgentConversationInstance[],
): RunningAgentTypeIndex {
  const index: Record<string, string> = {};

  instances.forEach((instance, order) => {
    const match = encodeTypeMatch({ agentType: instance.agentType, order });
    const memoId = instance.source.memoId;
    if (memoId && !index[memoIndexKey(memoId)]) {
      index[memoIndexKey(memoId)] = match;
    }

    const threadId = instance.threadId;
    if (threadId && !index[threadIndexKey(threadId)]) {
      index[threadIndexKey(threadId)] = match;
    }
  });

  return index;
}

function uniqueThreadIds(
  instances: Record<string, AgentConversationInstance>,
): string[] {
  const ids = new Set<string>();
  for (const instance of Object.values(instances)) {
    if (instance.threadId) ids.add(instance.threadId);
  }
  return [...ids].sort();
}

type RunningAgentTypeIndexCache = {
  instances: Record<string, AgentConversationInstance> | null;
  runStateVersion: number | null;
  runIndex: ConversationRunIndex | null;
  typeIndex: RunningAgentTypeIndex | null;
};

const runningAgentTypeIndexCache: RunningAgentTypeIndexCache = {
  instances: null,
  runStateVersion: null,
  runIndex: null,
  typeIndex: null,
};

function hasSameRunIndex(
  previous: ConversationRunIndex | null,
  next: ConversationRunIndex,
): boolean {
  if (!previous) return false;
  const previousKeys = Object.keys(previous);
  const nextKeys = Object.keys(next);
  if (previousKeys.length !== nextKeys.length) return false;
  return previousKeys.every((key) => previous[key] === next[key]);
}

function selectRunningAgentTypeIndex(
  state: ReturnType<typeof useAgentSessionStore.getState>,
): RunningAgentTypeIndex {
  const instances = state.conversationRegistry.instances;
  const previousInstances = runningAgentTypeIndexCache.instances;
  const previousRunIndex = runningAgentTypeIndexCache.runIndex;
  let runIndex: ConversationRunIndex;

  if (
    runningAgentTypeIndexCache.instances === instances
    && runningAgentTypeIndexCache.runStateVersion === state.runStateVersion
    && runningAgentTypeIndexCache.runIndex
  ) {
    runIndex = runningAgentTypeIndexCache.runIndex;
  } else {
    const nextRunIndex = buildConversationRunIndex(
      state.threadProjections,
      uniqueThreadIds(instances),
    );
    runIndex = hasSameRunIndex(runningAgentTypeIndexCache.runIndex, nextRunIndex)
      ? runningAgentTypeIndexCache.runIndex!
      : nextRunIndex;
    runningAgentTypeIndexCache.instances = instances;
    runningAgentTypeIndexCache.runStateVersion = state.runStateVersion;
    runningAgentTypeIndexCache.runIndex = runIndex;
  }

  // Message-only projection updates do not increment runStateVersion. In that
  // common case this selector returns the cached result in O(1), without
  // scanning projections or conversations.
  if (
    runningAgentTypeIndexCache.typeIndex
    && previousInstances === instances
    && previousRunIndex === runIndex
  ) {
    return runningAgentTypeIndexCache.typeIndex;
  }

  const runningInstances = selectRunningAgentConversations({ instances }, runIndex);
  const typeIndex = buildRunningAgentTypeIndex(runningInstances);
  runningAgentTypeIndexCache.typeIndex = typeIndex;
  return typeIndex;
}

/**
 * Subscribe to the derived running-agent projection rather than the complete
 * conversation registry. The selector may inspect the canonical agent state,
 * but MemoList only receives memo/thread keys whose running type changed.
 */
export function useRunningAgentTypeIndex(): RunningAgentTypeIndex {
  const selector = useCallback(selectRunningAgentTypeIndex, []);

  return useAgentSessionStore(useShallow(selector));
}

export function findRunningAgentForMemo(
  index: RunningAgentIndex,
  memo: Pick<MemoItem, 'id' | 'agents'>,
): AgentConversationInstance | null {
  let match = index.byMemoId.get(memo.id);

  for (const agent of memo.agents) {
    const candidate = index.byThreadId.get(agent.threadId);
    if (candidate && (!match || candidate.order < match.order)) {
      match = candidate;
    }
  }

  return match?.instance ?? null;
}

export function findRunningAgentTypeForMemo(
  index: RunningAgentTypeIndex,
  memo: Pick<MemoItem, 'id' | 'agents'>,
): AgentConversationInstance['agentType'] | null {
  let match = decodeTypeMatch(index[memoIndexKey(memo.id)]);

  for (const agent of memo.agents) {
    const candidate = decodeTypeMatch(index[threadIndexKey(agent.threadId)]);
    if (candidate && (!match || candidate.order < match.order)) {
      match = candidate;
    }
  }

  return match?.agentType ?? null;
}
