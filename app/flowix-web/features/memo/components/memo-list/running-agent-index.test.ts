import { describe, expect, it } from 'vitest';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import type { MemoItem } from '@/types/memo-item';
import {
  buildRunningAgentIndex,
  buildRunningAgentTypeIndex,
  findRunningAgentForMemo,
  findRunningAgentTypeForMemo,
} from './running-agent-index';

function instance(
  input: Partial<AgentConversationInstance> = {},
): AgentConversationInstance {
  return {
    instanceId: 'instance-1',
    agentType: 'codex',
    title: 'Agent',
    threadId: null,
    source: { kind: 'thread-card' },
    createdAt: 0,
    updatedAt: 0,
    ...input,
  };
}

function memo(input: Partial<Pick<MemoItem, 'id' | 'agents'>> = {}): Pick<MemoItem, 'id' | 'agents'> {
  return {
    id: 'memo-1',
    agents: [],
    ...input,
  };
}

describe('running agent index', () => {
  it('matches by memo id and thread id', () => {
    const byMemo = instance({
      instanceId: 'by-memo',
      source: { kind: 'thread-card', memoId: 'memo-1' },
    });
    const byThread = instance({
      instanceId: 'by-thread',
      threadId: 'thread-1',
    });
    const index = buildRunningAgentIndex([byMemo, byThread]);

    expect(findRunningAgentForMemo(index, memo())).toBe(byMemo);
    expect(
      findRunningAgentForMemo(index, memo({ id: 'memo-2', agents: [
        { threadId: 'thread-1', title: 'Thread', agentType: 'codex' },
      ] })),
    ).toBe(byThread);
  });

  it('keeps the first matching instance in running-agent order', () => {
    const byThread = instance({
      instanceId: 'by-thread',
      threadId: 'thread-1',
    });
    const byMemo = instance({
      instanceId: 'by-memo',
      source: { kind: 'thread-card', memoId: 'memo-1' },
    });
    const index = buildRunningAgentIndex([byThread, byMemo]);

    expect(findRunningAgentForMemo(index, memo({
      agents: [{ threadId: 'thread-1', title: 'Thread', agentType: 'codex' }],
    }))).toBe(byThread);
  });

  it('returns null when there is no match', () => {
    const index = buildRunningAgentIndex([instance({ threadId: 'other-thread' })]);

    expect(findRunningAgentForMemo(index, memo())).toBeNull();
  });

  it('projects only agent types while preserving match priority', () => {
    const byThread = instance({
      instanceId: 'by-thread',
      threadId: 'thread-1',
      agentType: 'deepseek-harness',
    });
    const byMemo = instance({
      instanceId: 'by-memo',
      source: { kind: 'thread-card', memoId: 'memo-1' },
      agentType: 'codex',
    });
    const index = buildRunningAgentTypeIndex([byThread, byMemo]);

    expect(findRunningAgentTypeForMemo(index, memo({
      agents: [{ threadId: 'thread-1', title: 'Thread', agentType: 'codex' }],
    }))).toBe('deepseek-harness');
    expect(findRunningAgentTypeForMemo(index, memo({ id: 'memo-2' }))).toBeNull();
  });
});
