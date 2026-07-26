import { describe, expect, it } from 'vitest';

import {
  buildConversationRunIndex,
  getConversationRunSummary,
} from '@features/agent/store/conversation-run-index';
import { emptyThreadState } from '@features/agent/store/thread-runtime-state';

describe('conversation run index', () => {
  it('ignores message-only thread state changes', () => {
    const running = {
      ...emptyThreadState(),
      isLoading: true,
      activeRunId: 'run-1',
      runs: {
        'run-1': {
          runId: 'run-1',
          status: 'running' as const,
          startedAt: 42,
          agentType: 'flowix' as const,
          threadId: 'thread',
        },
      },
    };
    const before = buildConversationRunIndex({ thread: running }, ['thread']);
    const after = buildConversationRunIndex({
      thread: {
        ...running,
        pendingAssistantId: 'message-1',
      },
    }, ['thread']);

    expect(after).toEqual(before);
    expect(getConversationRunSummary(after, 'thread')).toMatchObject({
      runId: 'run-1',
      status: 'running',
      startedAt: 42,
    });
  });

  it('changes when lifecycle status changes', () => {
    const running = {
      ...emptyThreadState(),
      activeRunId: 'run-1',
      runs: {
        'run-1': {
          runId: 'run-1',
          status: 'running' as const,
          startedAt: 42,
          agentType: 'flowix' as const,
          threadId: 'thread',
        },
      },
    };
    const completed = {
      ...running,
      runs: {
        'run-1': { ...running.runs['run-1'], status: 'completed' as const },
      },
    };

    const before = buildConversationRunIndex({ thread: running }, ['thread']);
    const after = buildConversationRunIndex({ thread: completed }, ['thread']);
    expect(after).not.toEqual(before);
    expect(getConversationRunSummary(after, 'thread').status).toBe('completed');
  });
});
