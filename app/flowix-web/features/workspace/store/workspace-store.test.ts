import { beforeEach, describe, expect, it } from 'vitest';

import { useWorkspaceStore } from './workspace-store';

describe('workspace store', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      navigation: {
        phase: 'idle',
        requestId: 0,
        target: { kind: 'empty' },
        pendingTarget: null,
        previousTarget: null,
        failure: null,
        retryToken: null,
      },
    });
  });

  it('owns the runtime third-column target independently from restore state', () => {
    const requestId = useWorkspaceStore.getState().beginNavigation(
      { kind: 'external', path: '/notebook/readme.md', scopePath: '/notebook', transitionId: null },
      null,
    );
    useWorkspaceStore.getState().commitNavigation(requestId, {
      kind: 'external',
      path: '/notebook/readme.md',
      scopePath: '/notebook',
      transitionId: 3,
    });

    expect(useWorkspaceStore.getState().navigation).toEqual({
      phase: 'committed',
      requestId,
      target: {
        kind: 'external',
        path: '/notebook/readme.md',
        scopePath: '/notebook',
        transitionId: 3,
      },
      pendingTarget: null,
      previousTarget: { kind: 'empty' },
      failure: null,
      retryToken: null,
    });
  });

  it('ignores stale commits and preserves the committed target while loading', () => {
    const first = useWorkspaceStore.getState().beginNavigation({ kind: 'web', url: 'https://one.test' }, null);
    useWorkspaceStore.getState().commitNavigation(first, { kind: 'web', url: 'https://one.test' });
    const second = useWorkspaceStore.getState().beginNavigation({ kind: 'empty' }, null);

    expect(useWorkspaceStore.getState().navigation).toMatchObject({
      phase: 'loading',
      requestId: second,
      target: { kind: 'web', url: 'https://one.test' },
    });
    expect(useWorkspaceStore.getState().commitNavigation(first, { kind: 'empty' })).toBe(false);
    expect(useWorkspaceStore.getState().navigation.phase).toBe('loading');
  });

  it('records the latest navigation failure without discarding the last surface', () => {
    const requestId = useWorkspaceStore.getState().beginNavigation({ kind: 'web', url: 'https://one.test' }, 'retry-1');
    useWorkspaceStore.getState().commitNavigation(requestId, { kind: 'web', url: 'https://one.test' });
    const retryId = useWorkspaceStore.getState().beginNavigation({ kind: 'empty' }, 'retry-2');

    expect(useWorkspaceStore.getState().failNavigation(retryId, new Error('save refused'))).toBe(true);
    expect(useWorkspaceStore.getState().navigation).toEqual({
      phase: 'failed',
      requestId: retryId,
      target: { kind: 'web', url: 'https://one.test' },
      pendingTarget: { kind: 'empty' },
      previousTarget: { kind: 'web', url: 'https://one.test' },
      failure: {
        code: 'navigation-failed',
        message: 'save refused',
        requestId: retryId,
        retryToken: 'retry-2',
      },
      retryToken: 'retry-2',
    });
  });

  it('dismisses a failure while retaining the last committed target', () => {
    const committedId = useWorkspaceStore.getState().beginNavigation(
      { kind: 'web', url: 'https://one.test' },
      null,
    );
    useWorkspaceStore.getState().commitNavigation(
      committedId,
      { kind: 'web', url: 'https://one.test' },
    );
    const failedId = useWorkspaceStore.getState().beginNavigation(
      { kind: 'empty' },
      'retry-dismiss',
    );
    useWorkspaceStore.getState().failNavigation(failedId, new Error('failed'));

    expect(useWorkspaceStore.getState().dismissNavigationFailure()).toBe('retry-dismiss');
    expect(useWorkspaceStore.getState().navigation).toMatchObject({
      phase: 'committed',
      target: { kind: 'web', url: 'https://one.test' },
      pendingTarget: null,
      failure: null,
      retryToken: null,
    });
  });
});
