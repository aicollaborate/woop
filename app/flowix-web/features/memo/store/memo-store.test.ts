import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
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
      setSelectedTagId: vi.fn(),
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
    useMemoStore.setState({
      memos: [],
      selectedMemo: memo('current'),
      selectedNotebook: null,
      activeFilter: 'todos',
      activePluginId: null,
      activeFileBrowserPath: null,
      activeFileBrowserDocument: null,
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

  it('persists sidebar navigation and normalizes middle-column-only filters', () => {
    useMemoStore.getState().setActiveFilter('agents');

    let persisted = JSON.parse(localStorage.getItem('test-memo-store') ?? '{}');
    expect(persisted.state.activeFilter).toBe('agents');

    useMemoStore.getState().setActiveFilter('color');
    persisted = JSON.parse(localStorage.getItem('test-memo-store') ?? '{}');
    expect(persisted.state.activeFilter).toBe('all');

    useMemoStore.getState().setActiveFileBrowserPath('/tmp/flowix-files');
    persisted = JSON.parse(localStorage.getItem('test-memo-store') ?? '{}');
    expect(persisted.state.activeFileBrowserPath).toBe('/tmp/flowix-files');

    useMemoStore.getState().setActiveFileBrowserDocument({
      path: '/tmp/flowix-files/src/main.ts',
      scopePath: '/tmp/flowix-files',
    });
    persisted = JSON.parse(localStorage.getItem('test-memo-store') ?? '{}');
    expect(persisted.state.activeFileBrowserDocument).toEqual({
      path: '/tmp/flowix-files/src/main.ts',
      scopePath: '/tmp/flowix-files',
    });
  });
});
