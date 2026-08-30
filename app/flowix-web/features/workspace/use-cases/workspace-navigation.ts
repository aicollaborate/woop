import type { PluginDescriptor } from '@platform/tauri/client';
import { canonicalPath } from '@/lib/path';
import { flushDocumentPath } from '@features/document/store/document-session-service';
import { useDocumentStore } from '@features/document/store/document-store';
import { useMemoStore, type Notebook } from '@features/memo/store/memo-store';
import type { MemoItem } from '@/types/memo-item';
import { notebooks as notebooksClient } from '@platform/tauri/client';
import { useWorkspaceStore } from '@features/workspace/store/workspace-store';
import { EMPTY_WORKSPACE_TARGET } from '@features/workspace/store/workspace-target';
import type { WorkspaceTarget } from '@features/workspace/store/workspace-target';

export interface OpenMemoTargetParams {
  memoId: string;
  path: string | null;
  notebookId?: string | null;
  notebookPath?: string | null;
  history?: 'push' | 'skip';
  initialContent?: string;
  /** When supplied, selection is part of this navigation transaction. */
  memo?: MemoItem | null;
  /** Optional authoritative Notebook entity used during a cross-notebook open. */
  notebook?: Notebook | null;
}

export interface OpenExternalTargetOptions {
  history?: 'push' | 'skip';
  scopePath?: string | null;
}

type RetryAction = () => Promise<void>;

interface DocumentSnapshot {
  activeMemoSession: {
    memoId: string;
    path: string;
    notebookId: string | null;
    notebookPath: string | null;
  } | null;
  activeExternalSession: {
    path: string;
    scopePath: string | null;
  } | null;
  activeAgentConversationId: string | null;
}

const retryActions = new Map<string, RetryAction>();
let retrySequence = 0;

function pendingMemoTarget(params: OpenMemoTargetParams): WorkspaceTarget {
  return {
    kind: 'memo',
    memoId: params.memoId,
    path: params.path ?? '',
    notebookId: params.notebookId ?? params.notebook?.id ?? null,
    notebookPath: params.notebookPath ?? params.notebook?.path ?? null,
    transitionId: null,
  };
}

function pendingExternalTarget(
  path: string | null,
  options?: OpenExternalTargetOptions,
): WorkspaceTarget {
  return {
    kind: 'external',
    path: path ?? '',
    scopePath: options?.scopePath ? canonicalPath(options.scopePath) : null,
    transitionId: null,
  };
}

function beginNavigation(pendingTarget: WorkspaceTarget, retry: RetryAction | null): number {
  const previousRetryToken = useWorkspaceStore.getState().navigation.retryToken;
  if (previousRetryToken) retryActions.delete(previousRetryToken);

  const retryToken = retry ? `navigation-retry-${++retrySequence}` : null;
  const requestId = useWorkspaceStore.getState().beginNavigation(pendingTarget, retryToken);
  if (retryToken && retry) retryActions.set(retryToken, retry);
  return requestId;
}

function commitNavigation(requestId: number, target: WorkspaceTarget): boolean {
  const state = useWorkspaceStore.getState();
  const retryToken = state.navigation.requestId === requestId ? state.navigation.retryToken : null;
  const committed = state.commitNavigation(requestId, target);
  if (committed && retryToken) retryActions.delete(retryToken);
  return committed;
}

function isCurrentNavigation(requestId: number): boolean {
  return useWorkspaceStore.getState().isCurrentNavigation(requestId);
}

async function runNavigation(
  pendingTarget: WorkspaceTarget,
  operation: (requestId: number) => Promise<void>,
  retry: RetryAction,
  rollback?: (requestId: number) => Promise<void>,
): Promise<void> {
  const requestId = beginNavigation(pendingTarget, retry);
  try {
    await operation(requestId);
  } catch (error) {
    const workspace = useWorkspaceStore.getState();
    if (workspace.isCurrentNavigation(requestId)) {
      // Enter failed before compensation. Selection listeners must not turn a
      // failed navigation into a second, competing clear request.
      workspace.failNavigation(requestId, error);
      try {
        await rollback?.(requestId);
      } catch {
        // The original navigation error is the actionable failure. The
        // best-effort compensation is intentionally not allowed to hide it.
      }
    }
    throw error;
  }
}

function captureDocumentSnapshot(): DocumentSnapshot {
  const document = useDocumentStore.getState();
  return {
    activeMemoSession: document.activeMemoSession
      ? {
          memoId: document.activeMemoSession.memoId,
          path: document.activeMemoSession.path,
          notebookId: document.activeMemoSession.notebookId,
          notebookPath: document.activeMemoSession.notebookPath,
        }
      : null,
    activeExternalSession: document.activeExternalSession
      ? {
          path: document.activeExternalSession.path,
          scopePath: document.activeExternalSession.scopePath,
        }
      : null,
    activeAgentConversationId: document.activeAgentConversationId,
  };
}

async function restoreDocumentSnapshot(snapshot: DocumentSnapshot): Promise<void> {
  if (snapshot.activeMemoSession) {
    await useDocumentStore.getState().openMemoDocument({
      memoId: snapshot.activeMemoSession.memoId,
      path: snapshot.activeMemoSession.path,
      notebookId: snapshot.activeMemoSession.notebookId,
      notebookPath: snapshot.activeMemoSession.notebookPath,
      history: 'skip',
    });
    return;
  }
  if (snapshot.activeExternalSession) {
    await useDocumentStore.getState().openExternalDocument(
      snapshot.activeExternalSession.path,
      { history: 'skip', scopePath: snapshot.activeExternalSession.scopePath },
    );
    return;
  }
  if (snapshot.activeAgentConversationId) {
    await useDocumentStore.getState().openAgentConversation(
      snapshot.activeAgentConversationId,
      { history: 'skip' },
    );
    return;
  }
  await useDocumentStore.getState().clearDocument();
}

export async function retryLastNavigation(): Promise<void> {
  const navigation = useWorkspaceStore.getState().navigation;
  const token = navigation.phase === 'failed' ? navigation.retryToken : null;
  const retry = token ? retryActions.get(token) : undefined;
  if (!retry) throw new Error('No retryable navigation is available');
  await retry();
}

export function dismissNavigationFailure(): void {
  const token = useWorkspaceStore.getState().dismissNavigationFailure();
  if (token) retryActions.delete(token);
}

/** Switch the main workspace notebook as one navigation transaction. */
export async function selectNotebook(notebook: Notebook): Promise<void> {
  const previousMemo = useMemoStore.getState().selectedMemo;
  const previousNotebook = useMemoStore.getState().selectedNotebook;
  const previousDocument = captureDocumentSnapshot();
  let switchedNotebook = false;

  await runNavigation(
    EMPTY_WORKSPACE_TARGET,
    async (requestId) => {
      // Flush first. Changing the backend notebook before this point could
      // make a pending save observe the wrong notebook context.
      await useDocumentStore.getState().clearDocument();
      if (!useWorkspaceStore.getState().isCurrentNavigation(requestId)) return;

      await notebooksClient.setCurrent(notebook.id);
      switchedNotebook = true;
      if (!useWorkspaceStore.getState().isCurrentNavigation(requestId)) return;

      useMemoStore.getState().setSelectedNotebook(notebook);
      useMemoStore.getState().setSelectedMemo(null);
      await useMemoStore.getState().loadMemos({ notebookId: notebook.id });
      if (!useWorkspaceStore.getState().isCurrentNavigation(requestId)) return;

      const document = useDocumentStore.getState();
      if (document.activeMemoSession || document.activeExternalSession || document.activeAgentConversationId) {
        throw new Error(`Notebook switch left an active document session: ${notebook.id}`);
      }
      commitNavigation(requestId, EMPTY_WORKSPACE_TARGET);
    },
    () => selectNotebook(notebook),
    async (requestId) => {
      if (!useWorkspaceStore.getState().isCurrentNavigation(requestId)) return;
      if (switchedNotebook && previousNotebook?.id) {
        await notebooksClient.setCurrent(previousNotebook.id);
      }
      if (!useWorkspaceStore.getState().isCurrentNavigation(requestId)) return;
      useMemoStore.getState().setSelectedNotebook(previousNotebook);
      useMemoStore.getState().setSelectedMemo(previousMemo);
      await restoreDocumentSnapshot(previousDocument);
    },
  );
}

function publishMemoTargetIfCurrent(
  requestId: number,
  memoId: string,
  path: string | null,
): boolean {
  const document = useDocumentStore.getState();
  const session = document.activeMemoSession;
  if (
    !session
    || session.memoId !== memoId
    || (path !== null && canonicalPath(session.path) !== canonicalPath(path))
  ) return false;

  return commitNavigation(requestId, {
    kind: 'memo',
    memoId: session.memoId,
    path: session.path,
    notebookId: session.notebookId,
    notebookPath: session.notebookPath,
    transitionId: session.transitionId,
  });
}

function publishExternalTargetIfCurrent(
  requestId: number,
  path: string | null,
  scopePath: string | null,
): boolean {
  const document = useDocumentStore.getState();
  const session = document.activeExternalSession;
  if (
    !session
    || path === null
    || canonicalPath(session.path) !== canonicalPath(path)
    || (scopePath !== null && session.scopePath !== canonicalPath(scopePath))
  ) return false;

  return commitNavigation(requestId, {
    kind: 'external',
    path: session.path,
    scopePath: session.scopePath,
    transitionId: session.transitionId,
  });
}

export async function openMemoTarget(params: OpenMemoTargetParams): Promise<void> {
  const previousMemo = useMemoStore.getState().selectedMemo;
  const previousNotebook = useMemoStore.getState().selectedNotebook;
  const previousDocument = captureDocumentSnapshot();
  const notebookId = params.notebookId ?? params.notebook?.id ?? null;
  const memo = params.memo ?? null;
  let switchedNotebook = false;

  await runNavigation(
    pendingMemoTarget(params),
    async (requestId) => {
      let targetNotebook = params.notebook
        ?? useMemoStore.getState().notebooks.find((item) => item.id === notebookId)
        ?? null;
      const currentNotebookId = useMemoStore.getState().selectedNotebookId
        ?? useMemoStore.getState().selectedNotebook?.id
        ?? null;

      if (notebookId && currentNotebookId !== notebookId) {
        await notebooksClient.setCurrent(notebookId);
        switchedNotebook = true;
        if (!isCurrentNavigation(requestId)) return;

        if (!targetNotebook) {
          await useMemoStore.getState().loadNotebooks();
          if (!isCurrentNavigation(requestId)) return;
          targetNotebook = useMemoStore.getState().notebooks.find(
            (item) => item.id === notebookId,
          ) ?? null;
        }
        if (memo && !targetNotebook) {
          throw new Error(`Notebook is unavailable: ${notebookId}`);
        }
        if (targetNotebook) {
          useMemoStore.getState().setSelectedNotebook(targetNotebook);
          if (!isCurrentNavigation(requestId)) return;
        }
        await useMemoStore.getState().loadMemos({ notebookId });
        if (!isCurrentNavigation(requestId)) return;
      }

      if (!isCurrentNavigation(requestId)) return;
      if (memo) {
        const latest = useMemoStore.getState();
        latest.upsertMemo(memo);
        latest.setSelectedMemo(memo);
        if (!isCurrentNavigation(requestId)) return;
      }

      const { memo: _memo, notebook: _notebook, ...documentParams } = params;
      if (!isCurrentNavigation(requestId)) return;
      await useDocumentStore.getState().openMemoDocument({
        ...documentParams,
        notebookPath: params.notebookPath ?? targetNotebook?.path ?? null,
      });

      // A newer intent may have started while the document transition was
      // queued. Its session and target must remain authoritative.
      if (!useWorkspaceStore.getState().isCurrentNavigation(requestId)) return;
      if (!publishMemoTargetIfCurrent(requestId, params.memoId, params.path)) {
        throw new Error(`Memo session was not committed: ${params.memoId}`);
      }
    },
    () => openMemoTarget(params),
    async (requestId) => {
      if (!useWorkspaceStore.getState().isCurrentNavigation(requestId)) return;
      await restoreDocumentSnapshot(previousDocument);
      if (!useWorkspaceStore.getState().isCurrentNavigation(requestId)) return;
      if (memo && useMemoStore.getState().selectedMemo?.id === memo.id) {
        useMemoStore.getState().setSelectedMemo(previousMemo);
      }
      if (switchedNotebook) {
        const previousNotebookId = previousNotebook?.id ?? null;
        if (previousNotebookId) await notebooksClient.setCurrent(previousNotebookId);
        useMemoStore.getState().setSelectedNotebook(previousNotebook);
      }
    },
  );
}

export async function openExternalTarget(
  path: string | null,
  options?: OpenExternalTargetOptions,
): Promise<void> {
  const previousMemo = useMemoStore.getState().selectedMemo;
  const previousDocument = captureDocumentSnapshot();
  await runNavigation(
    pendingExternalTarget(path, options),
    async (requestId) => {
      useMemoStore.getState().setSelectedMemo(null);
      if (!isCurrentNavigation(requestId)) return;
      await useDocumentStore.getState().openExternalDocument(path, options);
      if (!useWorkspaceStore.getState().isCurrentNavigation(requestId)) return;
      const scopePath = options?.scopePath ? canonicalPath(options.scopePath) : null;
      if (path === null && !useDocumentStore.getState().activeExternalSession) {
        commitNavigation(requestId, EMPTY_WORKSPACE_TARGET);
      } else if (!publishExternalTargetIfCurrent(requestId, path, scopePath)) {
        throw new Error(`External document session was not committed: ${path}`);
      }
    },
    () => openExternalTarget(path, options),
    async (requestId) => {
      if (!isCurrentNavigation(requestId)) return;
      await restoreDocumentSnapshot(previousDocument);
      if (!isCurrentNavigation(requestId)) return;
      if (!useMemoStore.getState().selectedMemo) {
        useMemoStore.getState().setSelectedMemo(previousMemo);
      }
    },
  );
}

/** Flush the active editable document without clearing its session or target. */
export async function flushWorkspaceDocument(): Promise<void> {
  const document = useDocumentStore.getState();
  let flushed = true;

  if (document.activeMemoSession) {
    flushed = await flushDocumentPath(
      { kind: 'memo', id: document.activeMemoSession.memoId },
      document.activeMemoSession.path,
    );
  } else if (document.activeExternalSession) {
    flushed = await flushDocumentPath(
      { kind: 'external', path: document.activeExternalSession.path },
      document.activeExternalSession.path,
      document.activeExternalSession.scopePath,
    );
  }

  if (!flushed) {
    throw new Error('Document flush did not complete');
  }
}

export async function openAgentTarget(
  instanceId: string,
  options?: { history?: 'push' | 'skip' },
): Promise<void> {
  const normalized = instanceId.trim();
  if (!normalized) return;
  await runNavigation(
    { kind: 'agent-conversation', instanceId: normalized },
    async (requestId) => {
      await useDocumentStore.getState().openAgentConversation(normalized, options);
      if (!useWorkspaceStore.getState().isCurrentNavigation(requestId)) return;
      if (useDocumentStore.getState().activeAgentConversationId !== normalized) {
        throw new Error(`Agent conversation was not committed: ${normalized}`);
      }
      useMemoStore.getState().setActivePluginId(null);
      useMemoStore.getState().setSelectedMemo(null);
      if (!isCurrentNavigation(requestId)) return;
      commitNavigation(requestId, { kind: 'agent-conversation', instanceId: normalized });
    },
    () => openAgentTarget(normalized, options),
  );
}

export async function clearWorkspaceDocument(): Promise<void> {
  await runNavigation(
    EMPTY_WORKSPACE_TARGET,
    async (requestId) => {
      await useDocumentStore.getState().clearDocument();
      if (!useWorkspaceStore.getState().isCurrentNavigation(requestId)) return;
      const document = useDocumentStore.getState();
      if (document.activeMemoSession || document.activeExternalSession || document.activeAgentConversationId) {
        throw new Error('Document session was not cleared');
      }
      commitNavigation(requestId, EMPTY_WORKSPACE_TARGET);
    },
    () => clearWorkspaceDocument(),
  );
}

export function replaceActiveMemoPath(memoId: string, path: string): void {
  const current = useDocumentStore.getState().activeMemoSession;
  if (!current || current.memoId !== memoId) return;
  const requestId = beginNavigation({
    kind: 'memo',
    memoId,
    path,
    notebookId: current.notebookId,
    notebookPath: current.notebookPath,
    transitionId: null,
  }, null);
  useDocumentStore.getState().replaceActiveMemoPath(memoId, path);
  publishMemoTargetIfCurrent(requestId, memoId, path);
}

export async function discardMemoDocument(memoId: string): Promise<void> {
  await runNavigation(
    EMPTY_WORKSPACE_TARGET,
    async (requestId) => {
      await useDocumentStore.getState().discardMemoDocument(memoId);
      if (!useWorkspaceStore.getState().isCurrentNavigation(requestId)) return;
      const document = useDocumentStore.getState();
      const target = useWorkspaceStore.getState().navigation.target;
      if (
        target.kind === 'memo'
        && target.memoId === memoId
        && !document.activeMemoSession
      ) {
        commitNavigation(requestId, EMPTY_WORKSPACE_TARGET);
      } else {
        commitNavigation(requestId, target);
      }
    },
    () => discardMemoDocument(memoId),
  );
}

export function closeAgentTarget(): void {
  const workspace = useWorkspaceStore.getState();
  const wasActive = !!useDocumentStore.getState().activeAgentConversationId
    || workspace.navigation.target.kind === 'agent-conversation';
  const requestId = wasActive ? beginNavigation(EMPTY_WORKSPACE_TARGET, null) : null;
  useDocumentStore.getState().closeAgentConversation();
  if (requestId !== null && !useDocumentStore.getState().activeAgentConversationId) {
    commitNavigation(requestId, EMPTY_WORKSPACE_TARGET);
  }
}

/**
 * Leave the plugin workbench target without touching the active document.
 * Artifact-tool plugins use this path because they are second-column filters
 * and must preserve whatever the third column is currently showing.
 */
export function clearPluginWorkbenchTarget(): boolean {
  const workspace = useWorkspaceStore.getState();
  if (workspace.navigation.target.kind !== 'plugin-workbench') return false;
  const requestId = beginNavigation(EMPTY_WORKSPACE_TARGET, null);
  commitNavigation(requestId, EMPTY_WORKSPACE_TARGET);
  return true;
}

/** Open a document-independent plugin workbench after the current document is flushed. */
export async function openPluginWorkbench(plugin: PluginDescriptor): Promise<void> {
  await runNavigation(
    { kind: 'plugin-workbench', plugin },
    async (requestId) => {
      await useDocumentStore.getState().clearDocument();
      if (!useWorkspaceStore.getState().isCurrentNavigation(requestId)) return;
      useMemoStore.getState().setSelectedMemo(null);
      useMemoStore.getState().setActiveFilter('all');
      useMemoStore.getState().setActivePluginId(plugin.manifest.id);
      if (!isCurrentNavigation(requestId)) return;
      commitNavigation(requestId, { kind: 'plugin-workbench', plugin });
    },
    () => openPluginWorkbench(plugin),
  );
}

/** Close the plugin workbench and clear the document it owns, if any. */
export async function closePluginWorkbench(): Promise<boolean> {
  const workspace = useWorkspaceStore.getState();
  const previousTarget = workspace.navigation.target;
  if (previousTarget.kind !== 'plugin-workbench') return false;
  await runNavigation(
    EMPTY_WORKSPACE_TARGET,
    async (requestId) => {
      await useDocumentStore.getState().clearDocument();
      if (!useWorkspaceStore.getState().isCurrentNavigation(requestId)) return;
      useMemoStore.getState().setSelectedMemo(null);
      useMemoStore.getState().setActivePluginId(null);
      if (!isCurrentNavigation(requestId)) return;
      commitNavigation(requestId, EMPTY_WORKSPACE_TARGET);
    },
    () => closePluginWorkbench().then(() => undefined),
  );
  return true;
}

/** Reconcile local selection after an already-confirmed notebook deletion. */
export async function reconcileDeletedNotebook(
  deletedNotebookId: string,
  notebooks: Notebook[],
): Promise<void> {
  const wasSelected = (useMemoStore.getState().selectedNotebookId
    ?? useMemoStore.getState().selectedNotebook?.id
    ?? null) === deletedNotebookId;

  if (!wasSelected) {
    useMemoStore.getState().setNotebooks(notebooks);
    return;
  }

  const nextNotebook = notebooks[0] ?? null;
  const reconcile = () => runNavigation(
    EMPTY_WORKSPACE_TARGET,
    async (requestId) => {
      useMemoStore.getState().setNotebooks(notebooks);
      await useDocumentStore.getState().clearDocument();
      if (!isCurrentNavigation(requestId)) return;

      await notebooksClient.setCurrent(nextNotebook?.id ?? null);
      if (!isCurrentNavigation(requestId)) return;

      useMemoStore.getState().setSelectedNotebook(nextNotebook);
      useMemoStore.getState().setSelectedMemo(null);
      if (nextNotebook) {
        await useMemoStore.getState().loadMemos({ notebookId: nextNotebook.id });
        if (!isCurrentNavigation(requestId)) return;
      } else {
        useMemoStore.getState().setMemos([]);
      }
      commitNavigation(requestId, EMPTY_WORKSPACE_TARGET);
    },
    reconcile,
  );

  await reconcile();
}
