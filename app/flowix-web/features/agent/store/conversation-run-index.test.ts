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
            agentType: 'deepseek-harness' as const,
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
            agentType: 'deepseek-harness' as const,
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
          agentType: 'deepseek-harness' as const,
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

  it('exposes a pending DSH command as running conversation work', () => {
    const projection: ThreadProjection = {
      ...emptyProjection(),
      runs: {
        isLoading: false,
        activeRunId: null,
        runs: {},
        dshCommand: {
          id: 'command-1',
          name: 'compact',
          args: '',
          status: 'pending',
          startedAt: 84,
        },
      },
    };

    const index = buildConversationRunIndex({ thread: projection }, ['thread']);
    expect(getConversationRunSummary(index, 'thread')).toMatchObject({
      status: 'running',
      startedAt: 84,
    });
  });
});
