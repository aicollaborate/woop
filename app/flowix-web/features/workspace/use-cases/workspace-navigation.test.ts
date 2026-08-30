import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clearDocument: vi.fn(),
  openMemoDocument: vi.fn(),
  openExternalDocument: vi.fn(),
  openAgentConversation: vi.fn(),
  replaceActiveMemoPath: vi.fn(),
  discardMemoDocument: vi.fn(),
  closeAgentConversation: vi.fn(),
  flushDocumentPath: vi.fn(),
  beginNavigation: vi.fn().mockReturnValue(1),
  commitNavigation: vi.fn().mockReturnValue(true),
  failNavigation: vi.fn().mockReturnValue(true),
  isCurrentNavigation: vi.fn().mockReturnValue(true),
  memoState: {
    selectedMemo: null,
    selectedMemoId: null,
    selectedNotebook: null,
    selectedNotebookId: null,
    notebooks: [],
    upsertMemo: vi.fn(),
    setSelectedMemo: vi.fn(),
    setSelectedNotebook: vi.fn(),
    setActiveFilter: vi.fn(),
    setActivePluginId: vi.fn(),
    setNotebooks: vi.fn(),
    setMemos: vi.fn(),
    loadNotebooks: vi.fn(),
    loadMemos: vi.fn(),
  },
  documentState: {
    activeMemoSession: null as { memoId: string; path: string; notebookId: string | null; notebookPath: string | null; transitionId: number } | null,
    activeExternalSession: null as { path: string; scopePath: string | null; transitionId: number } | null,
    activeAgentConversationId: null as string | null,
  },
}));

vi.mock('@features/document/store/document-store', () => ({
  useDocumentStore: {
    getState: () => ({
      clearDocument: mocks.clearDocument,
      openMemoDocument: mocks.openMemoDocument,
      openExternalDocument: mocks.openExternalDocument,
      openAgentConversation: mocks.openAgentConversation,
      replaceActiveMemoPath: mocks.replaceActiveMemoPath,
      discardMemoDocument: mocks.discardMemoDocument,
      closeAgentConversation: mocks.closeAgentConversation,
      ...mocks.documentState,
    }),
  },
}));

vi.mock('@features/document/store/document-session-service', () => ({
  flushDocumentPath: mocks.flushDocumentPath,
}));

vi.mock('@platform/tauri/client', () => ({
  notebooks: { setCurrent: vi.fn() },
}));

vi.mock('@features/workspace/store/workspace-store', () => ({
  useWorkspaceStore: {
    getState: () => ({
      navigation: { phase: 'committed', requestId: 1, target: { kind: 'plugin-workbench', plugin: { manifest: { id: 'plugin-a' } } }, pendingTarget: null, previousTarget: null, failure: null, retryToken: null },
      beginNavigation: mocks.beginNavigation,
      commitNavigation: mocks.commitNavigation,
      failNavigation: mocks.failNavigation,
      isCurrentNavigation: mocks.isCurrentNavigation,
    }),
  },
}));

vi.mock('@features/memo/store/memo-store', () => ({
  useMemoStore: {
    getState: () => mocks.memoState,
  },
}));

import {
  closePluginWorkbench,
  flushWorkspaceDocument,
  openPluginWorkbench,
} from './workspace-navigation';

describe('workspace navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clearDocument.mockResolvedValue(undefined);
    mocks.openMemoDocument.mockResolvedValue(undefined);
    mocks.openExternalDocument.mockResolvedValue(undefined);
    mocks.openAgentConversation.mockResolvedValue(undefined);
    mocks.discardMemoDocument.mockResolvedValue(undefined);
    mocks.flushDocumentPath.mockResolvedValue(true);
    mocks.documentState.activeMemoSession = null;
    mocks.documentState.activeExternalSession = null;
    mocks.documentState.activeAgentConversationId = null;
    mocks.memoState.selectedMemo = null;
    mocks.memoState.selectedMemoId = null;
    mocks.memoState.selectedNotebook = null;
    mocks.memoState.selectedNotebookId = null;
    mocks.memoState.notebooks = [];
    mocks.memoState.upsertMemo.mockClear();
    mocks.memoState.setSelectedMemo.mockClear();
    mocks.memoState.setSelectedNotebook.mockClear();
    mocks.memoState.setActiveFilter.mockClear();
    mocks.memoState.setActivePluginId.mockClear();
    mocks.memoState.setNotebooks.mockClear();
    mocks.memoState.setMemos.mockClear();
    mocks.memoState.loadNotebooks.mockResolvedValue(undefined);
    mocks.memoState.loadMemos.mockResolvedValue(undefined);
  });

  it('publishes the committed memo session as the workspace target', async () => {
    mocks.openMemoDocument.mockImplementationOnce(async () => {
      mocks.documentState.activeMemoSession = {
        memoId: 'memo-1',
        path: '/notes/note.md',
        notebookId: 'notebook-1',
        notebookPath: '/notes',
        transitionId: 4,
      };
    });

    await import('./workspace-navigation').then(({ openMemoTarget }) => openMemoTarget({
      memoId: 'memo-1',
      path: '/notes\\note.md',
      notebookId: 'notebook-1',
      notebookPath: '/notes',
    }));

    expect(mocks.commitNavigation).toHaveBeenCalledWith(1, {
      kind: 'memo',
      memoId: 'memo-1',
      path: '/notes/note.md',
      notebookId: 'notebook-1',
      notebookPath: '/notes',
      transitionId: 4,
    });
  });

  it('opens a plugin workbench after the document has been cleared', async () => {
    await openPluginWorkbench({ manifest: { id: 'plugin-b' } } as never);

    expect(mocks.clearDocument).toHaveBeenCalledOnce();
    expect(mocks.commitNavigation).toHaveBeenCalledWith(1, {
      kind: 'plugin-workbench',
      plugin: { manifest: { id: 'plugin-b' } },
    });
    expect(mocks.memoState.setSelectedMemo).toHaveBeenCalledWith(null);
    expect(mocks.memoState.setActiveFilter).toHaveBeenCalledWith('all');
    expect(mocks.memoState.setActivePluginId).toHaveBeenCalledWith('plugin-b');
  });

  it('restores the workbench target when closing cannot flush the document', async () => {
    const failure = new Error('save refused');
    mocks.clearDocument.mockRejectedValueOnce(failure);

    await expect(closePluginWorkbench()).rejects.toBe(failure);
    expect(mocks.failNavigation).toHaveBeenCalledWith(1, failure);
  });

  it('flushes the active memo without clearing its document session', async () => {
    mocks.documentState.activeMemoSession = {
      memoId: 'memo-1',
      path: '/notes/memo-1.md',
      notebookId: 'notebook-1',
      notebookPath: '/notes',
      transitionId: 4,
    };

    await flushWorkspaceDocument();

    expect(mocks.flushDocumentPath).toHaveBeenCalledWith(
      { kind: 'memo', id: 'memo-1' },
      '/notes/memo-1.md',
    );
    expect(mocks.clearDocument).not.toHaveBeenCalled();
  });
});
