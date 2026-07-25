import { describe, expect, it } from 'vitest';

import {
  computeTagDropPosition,
  getSubtreeIds,
  rebuildTagOptionsFromLayout,
  reorderTagLayout,
} from '@features/memo/components/tag-reorder';
import type {
  MemoTagLayoutItem,
  MemoTagTreeItem,
} from '@features/memo/services/memo-list-metadata-service';

// 构造 MemoTagTreeItem: id/fullPath 一致 (segment 节点 id 即 fullPath),
// name 取末段, depth 由 fullPath 的 '/' 数决定。
function tag(
  fullPath: string,
  count: number,
  depth: number,
  parentId: string | null,
): MemoTagTreeItem {
  const lastSlash = fullPath.lastIndexOf('/');
  const name = lastSlash > 0 ? fullPath.slice(lastSlash + 1) : fullPath;
  return { id: fullPath, parentId, name, fullPath, depth, count };
}

// 树: a(0) > a/b(1) > a/b/c(2);  d(0)
const OPTIONS: MemoTagTreeItem[] = [
  tag('a', 10, 0, null),
  tag('a/b', 5, 1, 'a'),
  tag('a/b/c', 2, 2, 'a/b'),
  tag('d', 7, 0, null),
];

describe('computeTagDropPosition', () => {
  // 行高 30: 上 1/3 [0,10) before, 下 1/3 (20,30] after, 中间 [10,20] inside。
  it('returns "before" in the upper third', () => {
    expect(computeTagDropPosition(0, 30)).toBe('before');
    expect(computeTagDropPosition(9, 30)).toBe('before');
  });

  it('returns "after" in the lower third', () => {
    expect(computeTagDropPosition(21, 30)).toBe('after');
    expect(computeTagDropPosition(30, 30)).toBe('after');
  });

  it('returns "inside" in the middle third (inclusive boundaries)', () => {
    expect(computeTagDropPosition(10, 30)).toBe('inside');
    expect(computeTagDropPosition(15, 30)).toBe('inside');
    expect(computeTagDropPosition(20, 30)).toBe('inside');
  });
});

describe('getSubtreeIds', () => {
  it('returns the whole subtree (self + descendants) for a root with children', () => {
    expect(getSubtreeIds(OPTIONS, 'a')).toEqual(['a', 'a/b', 'a/b/c']);
  });

  it('returns a partial subtree for a mid-level node', () => {
    expect(getSubtreeIds(OPTIONS, 'a/b')).toEqual(['a/b', 'a/b/c']);
  });

  it('returns just the leaf for a node without children', () => {
    expect(getSubtreeIds(OPTIONS, 'a/b/c')).toEqual(['a/b/c']);
    expect(getSubtreeIds(OPTIONS, 'd')).toEqual(['d']);
  });

  it('stops at the next sibling at the same depth (does not bleed into following roots)', () => {
    // 'a' subtree must not include 'd' (depth 0 == source depth 0 -> break).
    expect(getSubtreeIds(OPTIONS, 'a')).not.toContain('d');
  });

  it('returns [] for an unknown id', () => {
    expect(getSubtreeIds(OPTIONS, 'missing')).toEqual([]);
  });
});

describe('rebuildTagOptionsFromLayout', () => {
  it('rebuilds a segment tree from a fullPath layout, preserving layout order', () => {
    const layout: MemoTagLayoutItem[] = [
      { id: 'a', parentId: null },
      { id: 'a/b', parentId: 'a' },
    ];
    const counts = [
      tag('a', 10, 0, null),
      tag('a/b', 5, 1, 'a'),
    ];
    expect(rebuildTagOptionsFromLayout(layout, counts)).toEqual([
      { id: 'a', parentId: null, name: 'a', fullPath: 'a', depth: 0, count: 10 },
      { id: 'a/b', parentId: 'a', name: 'b', fullPath: 'a/b', depth: 1, count: 5 },
    ]);
  });

  it('honors a reordered layout (sibling reorder takes effect immediately)', () => {
    // layout 把 a/b 放到 a 之前 ── ensureSegment 仍按 layout 顺序, 但 childrenByParent
    // 按 fullPath 推导, root 顺序 = layout 里 root 出现顺序。
    const layout: MemoTagLayoutItem[] = [
      { id: 'd', parentId: null },
      { id: 'a', parentId: null },
      { id: 'a/b', parentId: 'a' },
    ];
    const counts = OPTIONS;
    const result = rebuildTagOptionsFromLayout(layout, counts);
    expect(result.map((t) => t.id)).toEqual(['d', 'a', 'a/b']);
  });

  it('derives depth from slash count and parent from the literal path', () => {
    const layout: MemoTagLayoutItem[] = [
      { id: 'x/y/z', parentId: 'x/y' },
    ];
    const result = rebuildTagOptionsFromLayout(layout, []);
    // 中间节点 x, x/y 由 ensureSegment 递归补全, 深度 = '/' 数。
    expect(result.map((t) => ({ id: t.id, depth: t.depth, parentId: t.parentId }))).toEqual([
      { id: 'x', depth: 0, parentId: null },
      { id: 'x/y', depth: 1, parentId: 'x' },
      { id: 'x/y/z', depth: 2, parentId: 'x/y' },
    ]);
  });

  it('falls back to count 0 for paths not present in the count source', () => {
    const layout: MemoTagLayoutItem[] = [{ id: 'new', parentId: null }];
    const result = rebuildTagOptionsFromLayout(layout, []);
    expect(result[0].count).toBe(0);
  });
});

describe('reorderTagLayout', () => {
  // layout 派生自 OPTIONS: [a, a/b, a/b/c, d]
  it('moves a root before another root', () => {
    const result = reorderTagLayout([], OPTIONS, 'd', 'a', 'before');
    expect(result?.map((i) => i.id)).toEqual(['d', 'a', 'a/b', 'a/b/c']);
  });

  it('moves a root after another root', () => {
    const result = reorderTagLayout([], OPTIONS, 'a', 'd', 'after');
    // a 整棵子树 (a, a/b, a/b/c) 移到 d 之后
    expect(result?.map((i) => i.id)).toEqual(['d', 'a', 'a/b', 'a/b/c']);
  });

  it('moves a subtree (with descendants) as a block before a target', () => {
    const result = reorderTagLayout([], OPTIONS, 'a', 'd', 'before');
    expect(result?.map((i) => i.id)).toEqual(['a', 'a/b', 'a/b/c', 'd']);
    // 原本 a 子树就在 d 前, before d 仍是 [a,a/b,a/b/c,d] ── 顺序不变, 验证子树成块不拆散。
  });

  it('moves a subtree (with descendants) as a block after a target', () => {
    // 先把 d 放到 a 前, 再把 a 子树 after d ── 等价于把 a 子树整体挪到 d 后。
    const reordered = reorderTagLayout([], OPTIONS, 'd', 'a', 'before')!;
    const result = reorderTagLayout(reordered, OPTIONS, 'a', 'd', 'after');
    expect(result?.map((i) => i.id)).toEqual(['d', 'a', 'a/b', 'a/b/c']);
  });

  it('returns null when target is inside the source subtree (cannot drop parent onto its own child)', () => {
    expect(reorderTagLayout([], OPTIONS, 'a', 'a/b', 'before')).toBeNull();
    expect(reorderTagLayout([], OPTIONS, 'a', 'a/b/c', 'after')).toBeNull();
  });

  it('returns null when target is not in the layout', () => {
    expect(reorderTagLayout([], OPTIONS, 'a', 'missing', 'before')).toBeNull();
  });

  it('returns null when source is unknown (empty subtree)', () => {
    expect(reorderTagLayout([], OPTIONS, 'missing', 'd', 'before')).toBeNull();
  });

  it('does not mutate the input layout', () => {
    const layout: MemoTagLayoutItem[] = [
      { id: 'a', parentId: null },
      { id: 'd', parentId: null },
    ];
    reorderTagLayout(layout, OPTIONS, 'd', 'a', 'before');
    expect(layout).toEqual([
      { id: 'a', parentId: null },
      { id: 'd', parentId: null },
    ]);
  });
});
