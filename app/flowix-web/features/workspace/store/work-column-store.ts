import { create } from 'zustand';

import {
  EMPTY_WORK_COLUMN_TARGET,
  type WorkColumnNavigationState,
  type WorkColumnTarget,
} from './work-column-target';

/**
 * Runtime state owned by the workColumn.
 *
 * This store owns target intent and navigation transactions only. Document
 * data and editable sessions remain in DocumentStore; list and notebook
 * selection remain in MemoStore.
 */
export interface WorkColumnStore {
  navigation: WorkColumnNavigationState;
  beginNavigation: (
    pendingTarget: WorkColumnTarget,
    retryToken: string | null,
    preservePreviousTarget?: boolean,
  ) => number;
  commitNavigation: (requestId: number, target: WorkColumnTarget) => boolean;
  failNavigation: (requestId: number, error: unknown) => boolean;
  dismissNavigationFailure: () => string | null;
  isCurrentNavigation: (requestId: number) => boolean;
}

export const useWorkColumnStore = create<WorkColumnStore>()((set, get) => ({
  navigation: {
    phase: 'idle',
    requestId: 0,
    target: EMPTY_WORK_COLUMN_TARGET,
    pendingTarget: null,
    previousTarget: null,
    failure: null,
    retryToken: null,
  },
  beginNavigation: (pendingTarget, retryToken, preservePreviousTarget = false) => {
    const requestId = get().navigation.requestId + 1;
    set((state) => ({
      navigation: {
        phase: 'loading',
        requestId,
        target: state.navigation.target,
        pendingTarget,
        previousTarget: preservePreviousTarget
          ? state.navigation.previousTarget
          : state.navigation.target,
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
