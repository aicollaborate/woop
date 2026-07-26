import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoItem } from '@/types/memo-item';
import type { Notebook } from '@features/memo/store/memo-store';

const testState = vi.hoisted(() => ({
  selectedMemo: null as MemoItem | null,
  selectedNotebook: null as Notebook | null,
  activeMemoSession: null as { memoId: string; path: string } | null,
  currentDocumentSource: null as 'memo' | 'external' | null,
  setSelectedMemo: vi.fn((memo: MemoItem | null) => {
    testState.selectedMemo = memo;
  }),
  openMemoDocument: vi.fn(async (input: { memoId: string; path: string | null }) => {
    testState.activeMemoSession = {
      memoId: input.memoId,
      path: input.path ?? '',
    };
    testState.currentDocumentSource = 'memo';
  }),
}));

vi.mock('@features/memo', () => ({
  useMemoStore: {
    getState: () => ({
      selectedMemo: testState.selectedMemo,
      selectedNotebook: testState.selectedNotebook,
      setSelectedMemo: testState.setSelectedMemo,
    }),
  },
}));

vi.mock('@features/document', () => ({
  useDocumentStore: {
    getState: () => ({
      activeMemoSession: testState.activeMemoSession,
      currentDocumentSource: testState.currentDocumentSource,
      openMemoDocument: testState.openMemoDocument,
    }),
  },
}));

import { restorePersistedMemoSession } from '@features/memo/use-cases/open-memo-session';

const memo: MemoItem = {
  id: 'memo-1',
  filename: 'Memo.md',
  preview: '',
  tags: [],
  todos: [],
  agents: [],
  createdAt: 1,
  updatedAt: 1,
  favorited: false,
  icon: null,
  colors: [],
  properties: {},
};

const notebook: Notebook = {
  id: 'notebook-1',
  name: 'Notebook',
  path: '/notebook',
  createdAt: 1,
  updatedAt: 1,
  isDefault: true,
};

describe('restorePersistedMemoSession', () => {
  beforeEach(() => {
    testState.selectedMemo = memo;
    testState.selectedNotebook = notebook;
    testState.activeMemoSession = null;
    testState.currentDocumentSource = null;
    testState.setSelectedMemo.mockClear();
    testState.openMemoDocument.mockClear();
    testState.openMemoDocument.mockImplementation(async (input) => {
      testState.activeMemoSession = {
        memoId: input.memoId,
        path: input.path ?? '',
      };
      testState.currentDocumentSource = 'memo';
    });
  });

  it('opens a persisted memo once and then recognizes its active session', async () => {
    await restorePersistedMemoSession();
    await restorePersistedMemoSession();

    expect(testState.openMemoDocument).toHaveBeenCalledOnce();
    expect(testState.openMemoDocument).toHaveBeenCalledWith({
      memoId: memo.id,
      path: '/notebook/Memo.md',
      notebookId: notebook.id,
      notebookPath: notebook.path,
    });
  });

  it('does not replace an external document session', async () => {
    testState.currentDocumentSource = 'external';

    await restorePersistedMemoSession();

    expect(testState.openMemoDocument).not.toHaveBeenCalled();
  });

  it('coalesces concurrent restore attempts for the same memo', async () => {
    let finishOpen: (() => void) | undefined;
    testState.openMemoDocument.mockImplementation(
      () => new Promise<void>((resolve) => {
        finishOpen = resolve;
      }),
    );

    const first = restorePersistedMemoSession();
    const second = restorePersistedMemoSession();

    expect(testState.openMemoDocument).toHaveBeenCalledOnce();
    finishOpen?.();
    await Promise.all([first, second]);
  });
});
