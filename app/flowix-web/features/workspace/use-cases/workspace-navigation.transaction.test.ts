import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  memoState: {
    selectedMemo: null as { id: string } | null,
    selectedMemoId: null as string | null,
    selectedNotebook: null as { id: string; path: string } | null,
    selectedNotebookId: null as string | null,
    notebooks: [] as Array<{ id: string; path: string }>,
    upsertMemo: vi.fn(),
    setSelectedMemo: vi.fn((memo: { id: string } | null) => {
      mocks.memoState.selectedMemo = memo;
      mocks.memoState.selectedMemoId = memo?.id ?? null;
    }),
    setSelectedNotebook: vi.fn((notebook: { id: string; path: string } | null) => {
      mocks.memoState.selectedNotebook = notebook;
      mocks.memoState.selectedNotebookId = notebook?.id ?? null;
    }),
    setNotebooks: vi.fn((notebooks: Array<{ id: string; path: string }>) => {
      mocks.memoState.notebooks = notebooks;
      if (!notebooks.some((item) => item.id === mocks.memoState.selectedNotebookId)) {
        mocks.memoState.selectedNotebook = null;
        mocks.memoState.selectedNotebookId = null;
      }
    }),
    setMemos: vi.fn(),
    setActiveFilter: vi.fn(),
    setActivePluginId: vi.fn(),
    loadNotebooks: vi.fn(),
    loadMemos: vi.fn(),
  },
  documentState: {
    activeMemoSession: null as {
      memoId: string;
      path: string;
      notebookId: string | null;
      notebookPath: string | null;
      transitionId: number;
    } | null,
    activeExternalSession: null as {
      path: string;
      scopePath: string | null;
      transitionId: number;
    } | null,
    activeAgentConversationId: null,
  },
  clearDocument: vi.fn(),
  openMemoDocument: vi.fn(),
  openExternalDocument: vi.fn(),
  setCurrentNotebook: vi.fn(),
}));

vi.mock('@features/memo/store/memo-store', () => ({
  useMemoStore: { getState: () => mocks.memoState },
}));

vi.mock('@features/document/store/document-store', () => ({
  useDocumentStore: {
    getState: () => ({
      ...mocks.documentState,
      clearDocument: mocks.clearDocument,
      openMemoDocument: mocks.openMemoDocument,
      openExternalDocument: mocks.openExternalDocument,
    }),
  },
}));

vi.mock('@platform/tauri/client', () => ({
  notebooks: { setCurrent: mocks.setCurrentNotebook },
}));

import { useWorkspaceStore } from '../store/workspace-store';
import {
  dismissNavigationFailure,
  openExternalTarget,
  openMemoTarget,
  reconcileDeletedNotebook,
  retryLastNavigation,
  selectNotebook,
} from './workspace-navigation';

function memo(id: string) {
  return { id } as never;
}

function resetWorkspace() {
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
}

describe('workspace navigation transaction', () => {
  beforeEach(() => {
    resetWorkspace();
    mocks.memoState.selectedMemo = { id: 'old' };
    mocks.memoState.selectedMemoId = 'old';
    mocks.memoState.selectedNotebook = null;
    mocks.memoState.selectedNotebookId = null;
    mocks.memoState.notebooks = [];
    mocks.documentState.activeMemoSession = null;
    mocks.documentState.activeExternalSession = null;
    mocks.openMemoDocument.mockReset();
    mocks.openExternalDocument.mockReset();
    mocks.openExternalDocument.mockResolvedValue(undefined);
    mocks.clearDocument.mockReset();
    mocks.clearDocument.mockResolvedValue(undefined);
    mocks.setCurrentNotebook.mockReset();
    mocks.setCurrentNotebook.mockResolvedValue(undefined);
    mocks.memoState.upsertMemo.mockClear();
    mocks.memoState.setSelectedMemo.mockClear();
    mocks.memoState.setSelectedNotebook.mockClear();
    mocks.memoState.setNotebooks.mockClear();
    mocks.memoState.setMemos.mockClear();
    mocks.memoState.setActiveFilter.mockClear();
    mocks.memoState.setActivePluginId.mockClear();
    mocks.memoState.loadNotebooks.mockResolvedValue(undefined);
    mocks.memoState.loadMemos.mockResolvedValue(undefined);
  });

  it('rolls back memo selection and retains the previous target on failure', async () => {
    const failure = new Error('save refused');
    mocks.openMemoDocument.mockRejectedValueOnce(failure);

    await expect(openMemoTarget({
      memoId: 'new',
      path: '/notes/new.md',
      memo: memo('new'),
    })).rejects.toBe(failure);

    expect(mocks.memoState.selectedMemo?.id).toBe('old');
    expect(useWorkspaceStore.getState().navigation).toMatchObject({
      phase: 'failed',
      pendingTarget: { kind: 'memo', memoId: 'new' },
      previousTarget: { kind: 'empty' },
      failure: { message: 'save refused', retryToken: 'navigation-retry-1' },
    });
  });

  it('retries the failed operation and commits the new target', async () => {
    mocks.openMemoDocument
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockImplementationOnce(async (params) => {
        mocks.documentState.activeMemoSession = {
          memoId: params.memoId,
          path: params.path,
          notebookId: null,
          notebookPath: null,
          transitionId: 2,
        };
      });

    await expect(openMemoTarget({
      memoId: 'retry-me',
      path: '/notes/retry-me.md',
      memo: memo('retry-me'),
    })).rejects.toThrow('temporary failure');

    await retryLastNavigation();

    expect(useWorkspaceStore.getState().navigation).toMatchObject({
      phase: 'committed',
      target: { kind: 'memo', memoId: 'retry-me', transitionId: 2 },
      pendingTarget: null,
      failure: null,
      retryToken: null,
    });
  });

  it('allows the latest request to win when opens finish out of order', async () => {
    const pending: Array<{
      params: { memoId: string; path: string };
      resolve: () => void;
    }> = [];
    mocks.openMemoDocument.mockImplementation((params) => new Promise<void>((resolve) => {
      pending.push({
        params,
        resolve: () => {
          mocks.documentState.activeMemoSession = {
            memoId: params.memoId,
            path: params.path,
            notebookId: null,
            notebookPath: null,
            transitionId: params.memoId === 'first' ? 1 : 2,
          };
          resolve();
        },
      });
    }));

    const first = openMemoTarget({ memoId: 'first', path: '/notes/first.md', memo: memo('first') });
    const second = openMemoTarget({ memoId: 'second', path: '/notes/second.md', memo: memo('second') });
    pending[0].resolve();
    await Promise.resolve();
    pending[1].resolve();
    await Promise.all([first, second]);

    expect(useWorkspaceStore.getState().navigation.target).toMatchObject({
      kind: 'memo',
      memoId: 'second',
      transitionId: 2,
    });
    expect(mocks.memoState.selectedMemo?.id).toBe('second');
  });

  it('ignores a stale cross-notebook open when the later request commits first', async () => {
    const baseNotebook = {
      id: 'base-notebook',
      name: 'Base notebook',
      path: '/base',
      createdAt: 0,
      updatedAt: 0,
      isDefault: true,
    };
    const firstNotebook = {
      ...baseNotebook,
      id: 'first-notebook',
      name: 'First notebook',
      path: '/first',
      isDefault: false,
    };
    const secondNotebook = {
      ...baseNotebook,
      id: 'second-notebook',
      name: 'Second notebook',
      path: '/second',
      isDefault: false,
    };
    mocks.memoState.selectedNotebook = baseNotebook;
    mocks.memoState.selectedNotebookId = baseNotebook.id;

    let resolveFirstMetadataLoad: (() => void) | undefined;
    mocks.memoState.loadNotebooks.mockImplementationOnce(() => (
      new Promise<void>((resolve) => { resolveFirstMetadataLoad = resolve; })
    ));
    mocks.openMemoDocument.mockImplementation(async (params) => {
      mocks.documentState.activeMemoSession = {
        memoId: params.memoId,
        path: params.path,
        notebookId: params.notebookId ?? null,
        notebookPath: params.notebookPath ?? null,
        transitionId: params.memoId === 'first' ? 1 : 2,
      };
    });

    const first = openMemoTarget({
      memoId: 'first',
      path: '/first/first.md',
      memo: memo('first'),
      notebookId: firstNotebook.id,
      notebookPath: firstNotebook.path,
    });
    expect(mocks.setCurrentNotebook).toHaveBeenCalledWith(firstNotebook.id);

    const second = openMemoTarget({
      memoId: 'second',
      path: '/second/second.md',
      memo: memo('second'),
      notebook: secondNotebook,
    });
    await second;
    resolveFirstMetadataLoad?.();
    await first;

    expect(useWorkspaceStore.getState().navigation.target).toMatchObject({
      kind: 'memo',
      memoId: 'second',
      transitionId: 2,
    });
    expect(mocks.documentState.activeMemoSession?.memoId).toBe('second');
    expect(mocks.memoState.selectedMemo?.id).toBe('second');
    expect(mocks.memoState.selectedNotebook?.id).toBe(secondNotebook.id);
  });

  it('restores the memo selection when opening an external document fails', async () => {
    mocks.openExternalDocument.mockRejectedValueOnce(new Error('external unavailable'));

    await expect(openExternalTarget('/workspace/readme.md', {
      scopePath: '/workspace',
    })).rejects.toThrow('external unavailable');

    expect(mocks.memoState.selectedMemo?.id).toBe('old');
    expect(useWorkspaceStore.getState().navigation).toMatchObject({
      phase: 'failed',
      pendingTarget: {
        kind: 'external',
        path: '/workspace/readme.md',
        scopePath: '/workspace',
      },
      failure: { message: 'external unavailable' },
    });
  });

  it('keeps a newer navigation authoritative when it starts during rollback', async () => {
    const failure = new Error('first open failed');
    let finishRollback: (() => void) | undefined;
    mocks.openMemoDocument
      .mockRejectedValueOnce(failure)
      .mockImplementationOnce(async (params) => {
        mocks.documentState.activeMemoSession = {
          memoId: params.memoId,
          path: params.path,
          notebookId: null,
          notebookPath: null,
          transitionId: 2,
        };
      });
    mocks.clearDocument.mockImplementationOnce(() => (
      new Promise<void>((resolve) => { finishRollback = resolve; })
    ));

    const first = openMemoTarget({
      memoId: 'first',
      path: '/notes/first.md',
      memo: memo('first'),
    }).catch((error) => error);
    await vi.waitFor(() => expect(mocks.clearDocument).toHaveBeenCalledOnce());

    await openMemoTarget({
      memoId: 'second',
      path: '/notes/second.md',
      memo: memo('second'),
    });
    finishRollback?.();

    expect(await first).toBe(failure);
    expect(useWorkspaceStore.getState().navigation).toMatchObject({
      phase: 'committed',
      target: { kind: 'memo', memoId: 'second' },
    });
    expect(mocks.memoState.selectedMemo?.id).toBe('second');
    expect(mocks.documentState.activeMemoSession?.memoId).toBe('second');
  });

  it('invalidates retry after the user dismisses a navigation failure', async () => {
    mocks.openMemoDocument.mockRejectedValueOnce(new Error('dismiss me'));

    await expect(openMemoTarget({
      memoId: 'dismissed',
      path: '/notes/dismissed.md',
      memo: memo('dismissed'),
    })).rejects.toThrow('dismiss me');

    dismissNavigationFailure();

    await expect(retryLastNavigation()).rejects.toThrow('No retryable navigation is available');
    expect(useWorkspaceStore.getState().navigation.failure).toBeNull();
  });

  it('rolls back notebook selection when switching the backend notebook fails', async () => {
    const previousNotebook = {
      id: 'old-notebook',
      name: 'Old notebook',
      path: '/old',
      createdAt: 0,
      updatedAt: 0,
      isDefault: false,
    };
    const nextNotebook = {
      id: 'next-notebook',
      name: 'Next notebook',
      path: '/next',
      createdAt: 0,
      updatedAt: 0,
      isDefault: false,
    };
    mocks.memoState.selectedNotebook = previousNotebook;
    mocks.memoState.selectedNotebookId = previousNotebook.id;
    mocks.setCurrentNotebook.mockRejectedValueOnce(new Error('notebook unavailable'));

    await expect(selectNotebook(nextNotebook)).rejects.toThrow('notebook unavailable');

    expect(mocks.memoState.selectedNotebook).toEqual(previousNotebook);
    expect(useWorkspaceStore.getState().navigation).toMatchObject({
      phase: 'failed',
      pendingTarget: { kind: 'empty' },
      failure: { message: 'notebook unavailable' },
    });
  });

  it('reconciles selection through the facade after deleting the active notebook', async () => {
    const deletedNotebook = {
      id: 'deleted-notebook',
      name: 'Deleted notebook',
      path: '/deleted',
      createdAt: 0,
      updatedAt: 0,
      isDefault: true,
    };
    const remainingNotebook = {
      ...deletedNotebook,
      id: 'remaining-notebook',
      name: 'Remaining notebook',
      path: '/remaining',
    };
    mocks.memoState.selectedNotebook = deletedNotebook;
    mocks.memoState.selectedNotebookId = deletedNotebook.id;

    await reconcileDeletedNotebook(deletedNotebook.id, [remainingNotebook]);

    expect(mocks.clearDocument).toHaveBeenCalledOnce();
    expect(mocks.setCurrentNotebook).toHaveBeenCalledWith(remainingNotebook.id);
    expect(mocks.memoState.selectedNotebook?.id).toBe(remainingNotebook.id);
    expect(mocks.memoState.selectedMemo).toBeNull();
    expect(mocks.memoState.loadMemos).toHaveBeenCalledWith({
      notebookId: remainingNotebook.id,
    });
    expect(useWorkspaceStore.getState().navigation).toMatchObject({
      phase: 'idle',
      target: { kind: 'empty' },
    });
  });
});
