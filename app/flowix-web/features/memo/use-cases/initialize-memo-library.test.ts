import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Notebook } from '@features/memo/store/memo-store';

const testState = vi.hoisted(() => ({
  notebooks: [] as Notebook[],
  selectedNotebookId: 'notebook-2' as string | null,
  selectedNotebook: null as Notebook | null,
  selectedMemo: { id: 'memo-stale' } as { id: string } | null,
  memos: [] as Array<{ id: string }>,
  activeFilter: 'all' as string,
  activeSort: 'createdAt' as string,
  activePluginId: null as string | null,
  colorFilter: 'any' as const,
  startupPhase: 'idle' as string,
  startupError: null as string | null,
  initialMemoQueryKey: null as string | null,
  listNotebooks: vi.fn(),
  listMemos: vi.fn(),
  loadMemos: vi.fn(),
  setNotebooks: vi.fn((notebooks: Notebook[]) => {
    testState.notebooks = notebooks;
    testState.selectedNotebook = notebooks.find(
      (notebook) => notebook.id === testState.selectedNotebookId,
    ) ?? null;
  }),
  setSelectedNotebook: vi.fn((notebook: Notebook | null) => {
    testState.selectedNotebook = notebook;
    testState.selectedNotebookId = notebook?.id ?? null;
  }),
  setSelectedMemo: vi.fn((memo: { id: string } | null) => {
    testState.selectedMemo = memo;
  }),
  setMemos: vi.fn((memos: Array<{ id: string }>) => {
    testState.memos = memos;
  }),
  setStartupPhase: vi.fn((phase: string, error: string | null = null) => {
    testState.startupPhase = phase;
    testState.startupError = error;
    if (phase === 'loading') testState.initialMemoQueryKey = null;
  }),
  setStartupReady: vi.fn((queryKey: string) => {
    testState.startupPhase = 'ready';
    testState.startupError = null;
    testState.initialMemoQueryKey = queryKey;
  }),
}));

vi.mock('@features/memo/services', () => ({
  notebookRepository: {
    list: testState.listNotebooks,
  },
  memoRepository: {
    list: testState.listMemos,
    listPluginNotes: vi.fn(),
  },
}));

vi.mock('@features/memo/store/memo-store', () => ({
  useMemoStore: {
    getState: () => ({
      notebooks: testState.notebooks,
      selectedNotebookId: testState.selectedNotebookId,
      selectedNotebook: testState.selectedNotebook,
      selectedMemo: testState.selectedMemo,
      memos: testState.memos,
      activeFilter: testState.activeFilter,
      activeSort: testState.activeSort,
      activePluginId: testState.activePluginId,
      colorFilter: testState.colorFilter,
      setNotebooks: testState.setNotebooks,
      setSelectedNotebook: testState.setSelectedNotebook,
      setSelectedMemo: testState.setSelectedMemo,
      setMemos: testState.setMemos,
      loadMemos: testState.loadMemos,
      setStartupPhase: testState.setStartupPhase,
      setStartupReady: testState.setStartupReady,
    }),
  },
}));

vi.mock('@features/memo/store/tag-store', () => ({
  useTagStore: {
    getState: () => ({ selectedTagId: null }),
  },
}));

import { initializeMemoLibrary } from './initialize-memo-library';

const notebooks: Notebook[] = [
  {
    id: 'notebook-1',
    name: 'One',
    path: '/one',
    createdAt: 1,
    updatedAt: 1,
    isDefault: true,
  },
  {
    id: 'notebook-2',
    name: 'Two',
    path: '/two',
    createdAt: 2,
    updatedAt: 2,
    isDefault: false,
  },
];

describe('initializeMemoLibrary', () => {
  beforeEach(() => {
    testState.notebooks = [];
    testState.selectedNotebookId = 'notebook-2';
    testState.selectedNotebook = null;
    testState.selectedMemo = { id: 'memo-stale' };
    testState.memos = [];
    testState.startupPhase = 'idle';
    testState.startupError = null;
    testState.initialMemoQueryKey = null;
    testState.listNotebooks.mockReset();
    testState.listMemos.mockReset();
    testState.loadMemos.mockReset();
    testState.setNotebooks.mockClear();
    testState.setSelectedNotebook.mockClear();
    testState.setSelectedMemo.mockClear();
    testState.setMemos.mockClear();
    testState.setStartupPhase.mockClear();
    testState.setStartupReady.mockClear();
  });

  it('loads the selected notebook and its first memo query as one startup flow', async () => {
    const initialMemos = [{ id: 'memo-1' }];
    testState.listNotebooks.mockResolvedValue(notebooks);
    testState.loadMemos.mockImplementation(async () => {
      testState.memos = initialMemos;
      return true;
    });

    await initializeMemoLibrary();

    expect(testState.listNotebooks).toHaveBeenCalledOnce();
    expect(testState.loadMemos).toHaveBeenCalledWith({
      notebookId: 'notebook-2',
      filter: 'all',
      sort: 'createdAt',
      tagId: undefined,
    });
    expect(testState.memos).toEqual(initialMemos);
    expect(testState.selectedNotebook?.id).toBe('notebook-2');
    expect(testState.startupPhase).toBe('ready');
    expect(testState.initialMemoQueryKey).toBe('notebook-2:all:createdAt:::');
  });

  it('publishes an error and allows a later retry', async () => {
    testState.listNotebooks.mockRejectedValueOnce(new Error('backend unavailable'));

    await expect(initializeMemoLibrary()).rejects.toThrow('backend unavailable');
    expect(testState.startupPhase).toBe('error');
    expect(testState.startupError).toBe('backend unavailable');

    testState.listNotebooks.mockResolvedValue(notebooks);
    testState.loadMemos.mockResolvedValue(true);
    await initializeMemoLibrary();

    expect(testState.startupPhase).toBe('ready');
    expect(testState.startupError).toBeNull();
  });

  it('shares concurrent startup calls', async () => {
    let resolveList: ((value: Notebook[]) => void) | undefined;
    testState.listNotebooks.mockImplementation(() => new Promise((resolve) => {
      resolveList = resolve;
    }));
    testState.loadMemos.mockResolvedValue(true);

    const first = initializeMemoLibrary();
    const second = initializeMemoLibrary();

    expect(testState.listNotebooks).toHaveBeenCalledOnce();
    resolveList?.(notebooks);
    await Promise.all([first, second]);
    expect(testState.startupPhase).toBe('ready');
  });

  it('does not mark a superseded memo response as the initial query', async () => {
    testState.listNotebooks.mockResolvedValue(notebooks);
    testState.loadMemos.mockResolvedValue(false);

    await initializeMemoLibrary();

    expect(testState.startupPhase).toBe('ready');
    expect(testState.initialMemoQueryKey).toBe('');
  });
});
