import { beforeEach, describe, expect, it } from 'vitest';
import {
  FOURTH_COLUMN_DEFAULT_SPLIT_RATIO,
  FOURTH_COLUMN_MIN_WIDTH,
  useFourthColumnStore,
} from './fourth-column-store';
import { useWorkspaceFocusStore } from './workspace-focus-store';

function tab(id: string, memoId = id) {
  return {
    id,
    title: `${id}.md`,
    icon: null,
    target: {
      kind: 'memo' as const,
      memoId,
      notebookId: 'notebook-1',
      notebookPath: '/notes',
      filePath: `/notes/${memoId}.md`,
    },
  };
}

describe('fourth column store', () => {
  beforeEach(() => useFourthColumnStore.getState().reset());

  it('focuses an existing target instead of duplicating it by default', () => {
    const store = useFourthColumnStore.getState();
    store.openTab(tab('memo:a', 'a'));
    store.openTab(tab('memo:a:second', 'a'));

    expect(useFourthColumnStore.getState()).toMatchObject({
      tabs: [tab('memo:a', 'a')],
      activeTabId: 'memo:a',
      visible: true,
    });
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('fourth-column');
  });

  it('deduplicates external views by canonical document path', () => {
    const store = useFourthColumnStore.getState();
    store.openTab({
      id: 'markdown',
      title: 'A',
      icon: null,
      target: { kind: 'external_markdown', filePath: '/notes/a.md' },
    });
    store.openTab({
      id: 'text',
      title: 'A',
      icon: null,
      target: {
        kind: 'external_text',
        filePath: '/notes\\a.md',
        scopePath: '/notes',
      },
    });

    expect(useFourthColumnStore.getState().tabs).toHaveLength(1);
    expect(useFourthColumnStore.getState().activeTabId).toBe('markdown');
  });

  it('reuses an existing target when replace-active would otherwise duplicate it', () => {
    const store = useFourthColumnStore.getState();
    store.openTab(tab('memo:a', 'a'));
    store.openTab(tab('memo:b', 'b'));

    store.openTab(tab('memo:a:replacement', 'a'), 'replace-active');

    expect(useFourthColumnStore.getState().tabs.map((item) => item.id)).toEqual(['memo:a']);
    expect(useFourthColumnStore.getState().activeTabId).toBe('memo:a');
  });

  it('returns focus to the main space when the last tab closes', () => {
    const store = useFourthColumnStore.getState();
    store.openTab(tab('a'));
    store.closeTab('a');

    expect(useFourthColumnStore.getState()).toMatchObject({
      tabs: [],
      activeTabId: null,
      visible: false,
    });
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('main-third');
  });

  it('clamps the split ratio to a safe range', () => {
    const store = useFourthColumnStore.getState();
    expect(useFourthColumnStore.getState().splitRatio).toBe(FOURTH_COLUMN_DEFAULT_SPLIT_RATIO);
    store.setSplitRatio(-1);
    expect(useFourthColumnStore.getState().splitRatio).toBe(0.05);
    store.setSplitRatio(9999);
    expect(useFourthColumnStore.getState().splitRatio).toBe(0.95);
    expect(FOURTH_COLUMN_MIN_WIDTH).toBe(360);
  });
});
