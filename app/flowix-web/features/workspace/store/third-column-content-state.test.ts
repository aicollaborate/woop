import { describe, expect, it } from 'vitest';

import type { WorkspaceNavigationState, WorkspaceTarget } from './workspace-target';
import { resolveThirdColumnContentState } from './third-column-content-state';

const emptyDocument = {
  activeMemoSession: null,
  activeExternalSession: null,
  activeAgentConversationId: null,
};

function navigation(
  target: WorkspaceTarget,
  overrides: Partial<WorkspaceNavigationState> = {},
): WorkspaceNavigationState {
  return {
    phase: target.kind === 'empty' ? 'idle' : 'committed',
    requestId: 1,
    target,
    pendingTarget: null,
    previousTarget: null,
    failure: null,
    retryToken: null,
    ...overrides,
  };
}

const memoA: WorkspaceTarget = {
  kind: 'memo',
  memoId: 'a',
  path: '/notes/a.md',
  notebookId: null,
  notebookPath: null,
  transitionId: 1,
};

const memoB: WorkspaceTarget = { ...memoA, memoId: 'b', path: '/notes/b.md', transitionId: null };

const sessionA = {
  id: 'memo:a',
  memoId: 'a',
  path: '/notes/a.md',
  notebookId: null,
  notebookPath: null,
  openedAt: 1,
  transitionId: 1,
};

describe('third-column content state', () => {
  it('keeps the loaded A session while navigation to B is in progress', () => {
    const state = resolveThirdColumnContentState(
      navigation(memoA, { phase: 'loading', pendingTarget: memoB, previousTarget: memoA }),
      { ...emptyDocument, activeMemoSession: sessionA },
    );

    expect(state).toEqual({
      status: 'transitioning',
      from: memoA,
      to: memoB,
      session: { kind: 'memo', session: sessionA },
    });
  });

  it('retains A as the active target and reports B after B fails', () => {
    const failure = {
      code: 'navigation-failed' as const,
      message: 'save refused',
      requestId: 2,
      retryToken: 'retry-b',
    };
    const state = resolveThirdColumnContentState(
      navigation(memoA, {
        phase: 'failed',
        requestId: 2,
        pendingTarget: memoB,
        previousTarget: memoA,
        failure,
        retryToken: 'retry-b',
      }),
      { ...emptyDocument, activeMemoSession: sessionA },
    );

    expect(state).toMatchObject({
      status: 'failed',
      target: memoA,
      attemptedTarget: memoB,
      session: { kind: 'memo', session: sessionA },
      failure,
    });
  });

  it('returns ready only after the target and loaded session are committed', () => {
    expect(resolveThirdColumnContentState(
      navigation(memoA),
      { ...emptyDocument, activeMemoSession: sessionA },
    )).toEqual({
      status: 'ready',
      target: memoA,
      session: { kind: 'memo', session: sessionA },
    });
  });
});
