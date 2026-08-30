import type { PluginDescriptor } from '@platform/tauri/client';

/**
 * The single navigation target owned by the main workspace.
 *
 * This is deliberately a domain value: it contains identities and paths,
 * never React callbacks, editor state, or rendered Surface props. Those are
 * supplied by the presentation adapter when the target is rendered.
 */
export type WorkspaceTarget =
  | { kind: 'empty' }
  | {
      kind: 'memo';
      memoId: string;
      path: string;
      notebookId: string | null;
      notebookPath: string | null;
      transitionId: number | null;
    }
  | {
      kind: 'external';
      path: string;
      scopePath: string | null;
      transitionId: number | null;
    }
  | { kind: 'agent-conversation'; instanceId: string }
  | { kind: 'plugin-workbench'; plugin: PluginDescriptor }
  | { kind: 'web'; url: string };

export const EMPTY_WORKSPACE_TARGET = { kind: 'empty' } as const satisfies WorkspaceTarget;

/**
 * Runtime navigation state. `target` is always the last committed target;
 * while a request is loading it deliberately remains unchanged so a partial
 * document session can never be mistaken for the requested surface.
 */
export type WorkspaceNavigationPhase = 'idle' | 'loading' | 'committed' | 'failed';

export interface NavigationFailure {
  code: 'navigation-failed' | 'navigation-stale';
  message: string;
  requestId: number;
  retryToken: string | null;
}

export interface WorkspaceNavigationState {
  /** `target` is always the last successfully committed target. */
  phase: WorkspaceNavigationPhase;
  requestId: number;
  target: WorkspaceTarget;
  /** The target currently being attempted, if any. */
  pendingTarget: WorkspaceTarget | null;
  /** Snapshot of the target that was active when the current request began. */
  previousTarget: WorkspaceTarget | null;
  failure: NavigationFailure | null;
  /** Opaque token used by the Facade to look up a retry operation. */
  retryToken: string | null;
}
