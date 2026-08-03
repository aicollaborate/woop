import { describe, expect, it } from 'vitest';

import {
  buildConversationRunIndex,
  getConversationRunSummary,
} from '@features/agent/store/conversation-run-index';
import { emptyProjection } from '@features/agent/store/session-reducer';
import type { ThreadProjection } from '@features/agent/store/session-reducer';

describe('conversation run index', () => {
  it('ignores message-only thread state changes', () => {
    const running: ThreadProjection = {
      ...emptyProjection(),
      runs: {
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
      },
    };
    const before = buildConversationRunIndex({ thread: running }, ['thread']);
    const after = buildConversationRunIndex({
      thread: {
        ...running,
        pending: { assistantId: 'message-1', reasoningId: null },
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
    const running: ThreadProjection = {
      ...emptyProjection(),
      runs: {
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
      },
    };
    const completed: ThreadProjection = {
      ...running,
      runs: {
        isLoading: false,
        activeRunId: null,
        runs: {
          'run-1': { ...running.runs.runs['run-1'], status: 'completed' as const, endedAt: 50 },
        },
        lastRun: {
          runId: 'run-1',
          status: 'completed' as const,
          agentType: 'flowix' as const,
          startedAt: 42,
          endedAt: 50,
        },
      },
    };

    const before = buildConversationRunIndex({ thread: running }, ['thread']);
    const after = buildConversationRunIndex({ thread: completed }, ['thread']);
    expect(after).not.toEqual(before);
    expect(getConversationRunSummary(after, 'thread').status).toBe('completed');
  });
});
