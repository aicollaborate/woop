import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  setSelectedTagId: vi.fn(),
}));

vi.mock('@features/memo/services', () => ({
  memoRepository: {
    list: mocks.list,
  },
  notebookRepository: {},
}));

vi.mock('@/lib/constants', () => ({
  STORAGE_KEYS: { MEMO: 'test-memo-store' },
}));

vi.mock('@features/memo/store/tag-store', () => ({
  useTagStore: {
    getState: () => ({
      selectedTagId: null,
      setSelectedTagId: mocks.setSelectedTagId,
    }),
  },
}));

import { useMemoStore } from '@features/memo/store/memo-store';
import type { MemoItem } from '@/types/memo-item';

function memo(id: string): MemoItem {
  return {
    id,
    filename: `${id}.md`,
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
}

describe('memo store list loading', () => {
  beforeEach(() => {
    mocks.list.mockReset();
    mocks.setSelectedTagId.mockReset();
    useMemoStore.setState({
      memos: [],
      selectedMemo: memo('current'),
      selectedNotebook: null,
      middleColumnView: 'notes',
      activeFilter: 'todos',
      activePluginId: null,
    });
  });

  it('updates a filtered list without clearing the document selection', async () => {
    const filteredMemo = memo('todo');
    mocks.list.mockResolvedValue({ memos: [filteredMemo] });

    await useMemoStore.getState().loadMemos({
      notebookId: 'notebook-1',
      filter: 'todos',
    });

    expect(useMemoStore.getState().memos).toEqual([filteredMemo]);
    expect(useMemoStore.getState().selectedMemo?.id).toBe('current');
  });

  it('ignores a stale response after a newer local list update', async () => {
    let resolveList: ((value: { memos: MemoItem[] }) => void) | undefined;
    mocks.list.mockImplementation(() => new Promise((resolve) => {
      resolveList = resolve;
    }));

    const pendingLoad = useMemoStore.getState().loadMemos({
      notebookId: 'notebook-1',
      filter: 'all',
    });
    const freshMemo = memo('fresh');
    useMemoStore.getState().setMemos([freshMemo]);

    resolveList?.({ memos: [memo('stale')] });

    await expect(pendingLoad).resolves.toBe(false);
    expect(useMemoStore.getState().memos).toEqual([freshMemo]);
  });

  it('loads the first page and appends the next page without duplicates', async () => {
    const first = memo('first');
    const second = memo('second');
    mocks.list
      .mockResolvedValueOnce({ memos: [first], nextCursor: 'cursor-1', hasMore: true })
      .mockResolvedValueOnce({ memos: [first, second], nextCursor: null, hasMore: false });
    useMemoStore.setState({
      selectedNotebook: {
        id: 'notebook-1',
        name: 'Notebook',
        path: '/tmp/notebook',
        createdAt: 1,
        updatedAt: 1,
        isDefault: true,
      },
      activeFilter: 'all',
    });

    await useMemoStore.getState().loadMemos({
      notebookId: 'notebook-1',
      filter: 'all',
    });
    await useMemoStore.getState().loadMoreMemos();

    expect(mocks.list).toHaveBeenNthCalledWith(1, expect.objectContaining({
      notebookId: 'notebook-1',
      limit: 50,
    }));
    expect(mocks.list).toHaveBeenNthCalledWith(2, expect.objectContaining({
      notebookId: 'notebook-1',
      limit: 50,
      cursor: 'cursor-1',
    }));
    expect(useMemoStore.getState().memos).toEqual([first, second]);
    expect(useMemoStore.getState().memoListHasMore).toBe(false);
  });

  it('persists sidebar navigation and normalizes middle-column-only filters', () => {
    useMemoStore.getState().setActiveFilter('agents');

    let persisted = JSON.parse(localStorage.getItem('test-memo-store') ?? '{}');
    expect(persisted.state.activeFilter).toBe('agents');
    expect(useMemoStore.getState().middleColumnView).toBe('conversations');
    expect(persisted.state.selectedMemoId).toBe('current');
    expect(persisted.state.selectedMemo).toBeUndefined();

    useMemoStore.getState().setActiveFilter('color');
    persisted = JSON.parse(localStorage.getItem('test-memo-store') ?? '{}');
    expect(persisted.state.activeFilter).toBe('all');
    expect(useMemoStore.getState().middleColumnView).toBe('notes');

  });

  it('exits a plugin view when notes is already the active filter', () => {
    useMemoStore.setState({
      activeFilter: 'all',
      activePluginId: 'plugin-1',
    });

    useMemoStore.getState().setActiveFilter('all');

    expect(useMemoStore.getState().activeFilter).toBe('all');
    expect(useMemoStore.getState().activePluginId).toBeNull();
  });
});
