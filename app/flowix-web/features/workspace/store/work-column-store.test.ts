import { beforeEach, describe, expect, it } from 'vitest';

import { useWorkColumnStore } from './work-column-store';

describe('work-column store', () => {
  beforeEach(() => {
    useWorkColumnStore.setState({
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

  it('owns the runtime work-column target independently from restore state', () => {
    const requestId = useWorkColumnStore.getState().beginNavigation(
      { kind: 'external', path: '/notebook/readme.md', scopePath: '/notebook', transitionId: null },
      null,
    );
    useWorkColumnStore.getState().commitNavigation(requestId, {
      kind: 'external',
      path: '/notebook/readme.md',
      scopePath: '/notebook',
      transitionId: 3,
    });

    expect(useWorkColumnStore.getState().navigation).toEqual({
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
    const first = useWorkColumnStore.getState().beginNavigation({ kind: 'web', url: 'https://one.test' }, null);
    useWorkColumnStore.getState().commitNavigation(first, { kind: 'web', url: 'https://one.test' });
    const second = useWorkColumnStore.getState().beginNavigation({ kind: 'empty' }, null);

    expect(useWorkColumnStore.getState().navigation).toMatchObject({
      phase: 'loading',
      requestId: second,
      target: { kind: 'web', url: 'https://one.test' },
    });
    expect(useWorkColumnStore.getState().commitNavigation(first, { kind: 'empty' })).toBe(false);
    expect(useWorkColumnStore.getState().navigation.phase).toBe('loading');
  });

  it('records the latest navigation failure without discarding the last surface', () => {
    const requestId = useWorkColumnStore.getState().beginNavigation({ kind: 'web', url: 'https://one.test' }, 'retry-1');
    useWorkColumnStore.getState().commitNavigation(requestId, { kind: 'web', url: 'https://one.test' });
    const retryId = useWorkColumnStore.getState().beginNavigation({ kind: 'empty' }, 'retry-2');

    expect(useWorkColumnStore.getState().failNavigation(retryId, new Error('save refused'))).toBe(true);
    expect(useWorkColumnStore.getState().navigation).toEqual({
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
    const committedId = useWorkColumnStore.getState().beginNavigation(
      { kind: 'web', url: 'https://one.test' },
      null,
    );
    useWorkColumnStore.getState().commitNavigation(
      committedId,
      { kind: 'web', url: 'https://one.test' },
    );
    const failedId = useWorkColumnStore.getState().beginNavigation(
      { kind: 'empty' },
      'retry-dismiss',
    );
    useWorkColumnStore.getState().failNavigation(failedId, new Error('failed'));

    expect(useWorkColumnStore.getState().dismissNavigationFailure()).toBe('retry-dismiss');
    expect(useWorkColumnStore.getState().navigation).toMatchObject({
      phase: 'committed',
      target: { kind: 'web', url: 'https://one.test' },
      pendingTarget: null,
      failure: null,
      retryToken: null,
    });
  });
});
