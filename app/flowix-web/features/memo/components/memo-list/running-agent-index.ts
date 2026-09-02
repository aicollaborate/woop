import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import type { MemoItem } from '@/types/memo-item';

type RankedAgent = {
  instance: AgentConversationInstance;
  order: number;
};

export type RunningAgentIndex = {
  byMemoId: Map<string, RankedAgent>;
  byThreadId: Map<string, RankedAgent>;
};

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
