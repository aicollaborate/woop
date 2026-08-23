import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Notebook } from '@features/memo/store/memo-store';

const testState = vi.hoisted(() => ({
  notebooks: [] as Notebook[],
  selectedNotebook: null as Notebook | null,
  selectedMemo: null as { id: string } | null,
  memos: [] as Array<{ id: string }>,
  list: vi.fn<() => Promise<Notebook[]>>(),
  setNotebooks: vi.fn((notebooks: Notebook[]) => {
    testState.notebooks = notebooks;
  }),
  setSelectedNotebook: vi.fn((notebook: Notebook | null) => {
    testState.selectedNotebook = notebook;
  }),
  setSelectedMemo: vi.fn((memo: { id: string } | null) => {
    testState.selectedMemo = memo;
  }),
  setMemos: vi.fn((memos: Array<{ id: string }>) => {
    testState.memos = memos;
  }),
}));

vi.mock('@features/memo/services', () => ({
  notebookRepository: {
    list: testState.list,
  },
}));

vi.mock('@features/memo/store/memo-store', () => ({
  useMemoStore: {
    getState: () => ({
      notebooks: testState.notebooks,
      selectedNotebook: testState.selectedNotebook,
      selectedMemo: testState.selectedMemo,
      memos: testState.memos,
      setNotebooks: testState.setNotebooks,
      setSelectedNotebook: testState.setSelectedNotebook,
      setSelectedMemo: testState.setSelectedMemo,
      setMemos: testState.setMemos,
    }),
  },
}));

import { bootstrapMemoLibrary } from './bootstrap-memo-library';

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

describe('bootstrapMemoLibrary', () => {
  beforeEach(() => {
    testState.notebooks = [];
    testState.selectedNotebook = null;
    testState.selectedMemo = null;
    testState.memos = [];
    testState.list.mockReset();
    testState.setNotebooks.mockClear();
    testState.setSelectedNotebook.mockClear();
    testState.setSelectedMemo.mockClear();
    testState.setMemos.mockClear();
  });

  it('restores the persisted notebook from the authoritative list', async () => {
    testState.selectedNotebook = { ...notebooks[1], name: 'Stale name' };
    testState.selectedMemo = { id: 'memo-2' };
    testState.list.mockResolvedValue(notebooks);

    const selected = await bootstrapMemoLibrary();

    expect(testState.setNotebooks).toHaveBeenCalledWith(notebooks);
    expect(testState.setSelectedNotebook).toHaveBeenCalledWith(notebooks[1]);
    expect(testState.setSelectedMemo).not.toHaveBeenCalled();
    expect(selected).toBe(notebooks[1]);
  });

  it('falls back to the first notebook and clears a stale document', async () => {
    testState.selectedNotebook = { ...notebooks[1], id: 'deleted-notebook' };
    testState.selectedMemo = { id: 'stale-memo' };
    testState.memos = [{ id: 'stale-memo' }];
    testState.list.mockResolvedValue(notebooks);

    const selected = await bootstrapMemoLibrary();

    expect(testState.setSelectedMemo).toHaveBeenCalledWith(null);
    expect(testState.setMemos).toHaveBeenCalledWith([]);
    expect(testState.setSelectedNotebook).toHaveBeenCalledWith(notebooks[0]);
    expect(selected).toBe(notebooks[0]);
  });

  it('clears persisted library state when no notebooks exist', async () => {
    testState.selectedNotebook = notebooks[0];
    testState.selectedMemo = { id: 'memo-1' };
    testState.memos = [{ id: 'memo-1' }];
    testState.list.mockResolvedValue([]);

    const selected = await bootstrapMemoLibrary();

    expect(testState.setNotebooks).toHaveBeenCalledWith([]);
    expect(testState.setSelectedNotebook).toHaveBeenCalledWith(null);
    expect(testState.setSelectedMemo).toHaveBeenCalledWith(null);
    expect(testState.setMemos).toHaveBeenCalledWith([]);
    expect(selected).toBeNull();
  });

  it('shares one backend request between concurrent startup consumers', async () => {
    let resolveList: ((value: Notebook[]) => void) | undefined;
    testState.list.mockImplementation(() => new Promise((resolve) => {
      resolveList = resolve;
    }));

    const first = bootstrapMemoLibrary();
    const second = bootstrapMemoLibrary();

    expect(testState.list).toHaveBeenCalledOnce();
    resolveList?.(notebooks);
    await expect(Promise.all([first, second])).resolves.toEqual([
      notebooks[0],
      notebooks[0],
    ]);
  });
});
