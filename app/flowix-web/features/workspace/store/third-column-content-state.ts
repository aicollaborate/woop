import type {
  ExternalDocumentSession,
  MemoDocumentSession,
} from '@features/document/store/document-store';
import { useDocumentStore } from '@features/document/store/document-store';

import { useWorkspaceStore } from './workspace-store';
import type {
  NavigationFailure,
  WorkspaceNavigationState,
  WorkspaceTarget,
} from './workspace-target';

export type ThirdColumnSession =
  | { kind: 'memo'; session: MemoDocumentSession }
  | { kind: 'external'; session: ExternalDocumentSession }
  | { kind: 'agent-conversation'; instanceId: string };

export type ThirdColumnContentState =
  | { status: 'empty' }
  | { status: 'ready'; target: WorkspaceTarget; session: ThirdColumnSession | null }
  | {
      status: 'transitioning';
      from: WorkspaceTarget;
      to: WorkspaceTarget;
      session: ThirdColumnSession | null;
    }
  | {
      status: 'failed';
      target: WorkspaceTarget;
      attemptedTarget: WorkspaceTarget;
      session: ThirdColumnSession | null;
      failure: NavigationFailure;
    };

interface ThirdColumnDocumentSnapshot {
  activeMemoSession: MemoDocumentSession | null;
  activeExternalSession: ExternalDocumentSession | null;
  activeAgentConversationId: string | null;
}

function activeSession(document: ThirdColumnDocumentSnapshot): ThirdColumnSession | null {
  if (document.activeMemoSession) {
    return { kind: 'memo', session: document.activeMemoSession };
  }
  if (document.activeExternalSession) {
    return { kind: 'external', session: document.activeExternalSession };
  }
  if (document.activeAgentConversationId) {
    return { kind: 'agent-conversation', instanceId: document.activeAgentConversationId };
  }
  return null;
}

/**
 * Read model for the third column. Navigation owns intent and transaction
 * status; DocumentStore owns the loaded editable session. This function only
 * combines those sources and never introduces another persisted state.
 */
export function resolveThirdColumnContentState(
  navigation: WorkspaceNavigationState,
  document: ThirdColumnDocumentSnapshot,
): ThirdColumnContentState {
  const session = activeSession(document);

  if (navigation.phase === 'loading' && navigation.pendingTarget) {
    return {
      status: 'transitioning',
      from: navigation.target,
      to: navigation.pendingTarget,
      session,
    };
  }

  if (navigation.phase === 'failed' && navigation.pendingTarget && navigation.failure) {
    return {
      status: 'failed',
      target: navigation.target,
      attemptedTarget: navigation.pendingTarget,
      session,
      failure: navigation.failure,
    };
  }

  if (navigation.target.kind === 'empty' && !session) return { status: 'empty' };
  return { status: 'ready', target: navigation.target, session };
}

/** Imperative read entry for use-cases outside React rendering. */
export function getThirdColumnContentState(): ThirdColumnContentState {
  return resolveThirdColumnContentState(
    useWorkspaceStore.getState().navigation,
    useDocumentStore.getState(),
  );
}
