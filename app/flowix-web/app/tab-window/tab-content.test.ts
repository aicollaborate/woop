import { describe, expect, it, vi } from 'vitest';
import type { MemoItem } from '@/types/memo-item';
import type { WindowTab } from '@platform/tauri/client';
import { resolveTabContentSurface } from './tab-content';

vi.mock('@features/surface', async () => {
  const actual = await vi.importActual<typeof import('@features/surface')>('@features/surface');
  return { ...actual, ThirdColumnSurfaceHost: () => null };
});

function memo(properties: Record<string, unknown>): MemoItem {
  return {
    id: 'memo-1',
    filename: 'mindmap.md',
    preview: '',
    tags: [],
    todos: [],
    agents: [],
    createdAt: 0,
    updatedAt: 0,
    favorited: false,
    icon: null,
    colors: [],
    properties,
  };
}

const memoTab: WindowTab = {
  id: 'memo:memo-1',
  title: 'mindmap.md',
  icon: null,
  target: {
    kind: 'memo',
    memoId: 'memo-1',
    notebookId: 'notebook-1',
    notebookPath: '/notebook',
    filePath: '/notebook/mindmap.md',
  },
};

const baseProps = {
  filePath: '/notebook/mindmap.md',
  notebookId: 'notebook-1',
  notebookPath: '/notebook',
};

describe('resolveTabContentSurface', () => {
  it('uses the same artifact resolution as the main third column', () => {
    const surface = resolveTabContentSurface({
      tab: memoTab,
      contentKey: 'memo:memo-1',
      memo: memo({
        flowix_note_type: 'mindmap',
        flowix_plugin: 'mindmap',
        flowix_artifact: { renderer: 'markmap' },
      }),
      memoContentProps: baseProps,
    });

    expect(surface.kind).toBe('mindmap');
  });

  it('keeps ordinary memo tabs as Markdown surfaces', () => {
    const surface = resolveTabContentSurface({
      tab: memoTab,
      contentKey: 'memo:memo-1',
      memo: memo({}),
      memoContentProps: baseProps,
    });

    expect(surface).toMatchObject({
      kind: 'markdown',
      props: {
        memoId: 'memo-1',
        filePath: '/notebook/mindmap.md',
        notebookId: 'notebook-1',
      },
    });
  });
});
