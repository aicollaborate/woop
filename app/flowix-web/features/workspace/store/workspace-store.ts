import { create } from 'zustand';

import {
  EMPTY_WORKSPACE_TARGET,
  type WorkspaceNavigationState,
  type WorkspaceTarget,
} from './workspace-target';

/**
 * Runtime navigation state for the main workspace.
 *
 * This store intentionally does not contain restore data, document content,
 * React props, or component callbacks. Domain stores own those concerns;
 * callers only publish the active third-column navigation target here.
 * During a transition, `navigation.target` remains the committed intent while
 * DocumentStore may still hold the outgoing loaded session. Read both through
 * `resolveThirdColumnContentState` when code needs a combined view.
 */
interface WorkspaceStore {
  navigation: WorkspaceNavigationState;
  beginNavigation: (pendingTarget: WorkspaceTarget, retryToken: string | null) => number;
  commitNavigation: (requestId: number, target: WorkspaceTarget) => boolean;
  failNavigation: (requestId: number, error: unknown) => boolean;
  dismissNavigationFailure: () => string | null;
  isCurrentNavigation: (requestId: number) => boolean;
}

export const useWorkspaceStore = create<WorkspaceStore>()((set, get) => ({
  navigation: {
    phase: 'idle',
    requestId: 0,
    target: EMPTY_WORKSPACE_TARGET,
    pendingTarget: null,
    previousTarget: null,
    failure: null,
    retryToken: null,
  },
  beginNavigation: (pendingTarget, retryToken) => {
    const requestId = get().navigation.requestId + 1;
    set((state) => ({
      navigation: {
        phase: 'loading',
        requestId,
        target: state.navigation.target,
        pendingTarget,
        previousTarget: state.navigation.target,
        failure: null,
        retryToken,
      },
    }));
    return requestId;
  },
  commitNavigation: (requestId, target) => {
    if (get().navigation.requestId !== requestId) return false;
    set({
      navigation: target.kind === 'empty'
        ? {
            phase: 'idle',
            requestId,
            target,
            pendingTarget: null,
            previousTarget: get().navigation.previousTarget,
            failure: null,
            retryToken: null,
          }
        : {
            phase: 'committed',
            requestId,
            target,
            pendingTarget: null,
            previousTarget: get().navigation.previousTarget,
            failure: null,
            retryToken: null,
          },
    });
    return true;
  },
  failNavigation: (requestId, error) => {
    if (get().navigation.requestId !== requestId) return false;
    set((state) => ({
      navigation: {
        phase: 'failed',
        requestId,
        target: state.navigation.target,
        pendingTarget: state.navigation.pendingTarget,
        previousTarget: state.navigation.previousTarget,
        failure: {
          code: 'navigation-failed',
          message: error instanceof Error ? error.message : String(error),
          requestId,
          retryToken: state.navigation.retryToken,
        },
        retryToken: state.navigation.retryToken,
      },
    }));
    return true;
  },
  dismissNavigationFailure: () => {
    const navigation = get().navigation;
    if (navigation.phase !== 'failed') return null;
    set({
      navigation: {
        phase: navigation.target.kind === 'empty' ? 'idle' : 'committed',
        requestId: navigation.requestId,
        target: navigation.target,
        pendingTarget: null,
        previousTarget: navigation.previousTarget,
        failure: null,
        retryToken: null,
      },
    });
    return navigation.retryToken;
  },
  isCurrentNavigation: (requestId) => get().navigation.requestId === requestId,
}));
