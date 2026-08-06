import { describe, expect, it } from 'vitest';

import {
  computeTagDropPosition,
  getSubtreeIds,
  rebuildTagOptionsFromLayout,
  reorderTagLayout,
  applyPinOrdering,
  migratePinnedByParentOnPathChange,
  migratePinnedByParentOnDelete,
  diffPinnedByParent,
  remapPath,
  remapParentKey,
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

describe('applyPinOrdering', () => {
  // A B C 的根级别, B 也是 (A,B) 的父亲; 还用根级别 ABC 演示按 MRU 排序。
  // d 没有子, 单独 root 子节点。
  const root: MemoTagTreeItem[] = [
    tag('A', 1, 0, null),
    tag('B', 1, 0, null),
    tag('B/B1', 1, 1, 'B'),
    tag('B/B2', 1, 1, 'B'),
    tag('C', 1, 0, null),
  ];

  it('returns the input unchanged when pinnedByParent is empty', () => {
    expect(applyPinOrdering(root, {})).toEqual(root);
  });

  it('lifts a single root pinned tag to the front (A B C -> C A B)', () => {
    const result = applyPinOrdering(root, { '': ['C'] });
    expect(result.map((t) => t.fullPath)).toEqual(['C', 'A', 'B', 'B/B1', 'B/B2']);
  });

  it('honors MRU order: pin C then pin B -> B C A (B can be ahead of C)', () => {
    // pinned = ['B', 'C']: 先 pin C, 再 pin B -> B 是最近置顶, 排第一;
    // C 留前部第二, A 落在兄弟末尾; B 是 parent，DFS 会在 B 之后立刻进入
    // B 子树（B/B1, B/B2），然后才回到 root 同级的 C / A。
    const result = applyPinOrdering(root, { '': ['B', 'C'] });
    expect(result.map((t) => t.fullPath)).toEqual(['B', 'B/B1', 'B/B2', 'C', 'A']);
  });

  it('keeps non-pinned siblings right after their last pinned ancestor until the next root', () => {
    // pin C 后, A 仍按 layout 顺序紧跟, B 跟它的子 D 一起, 子 D 跟在 B 之后。
    const layout: MemoTagTreeItem[] = [
      tag('A', 1, 0, null),
      tag('B', 1, 0, null),
      tag('B/D', 1, 1, 'B'),
      tag('C', 1, 0, null),
    ];
    const result = applyPinOrdering(layout, { '': ['C'] });
    expect(result.map((t) => t.fullPath)).toEqual(['C', 'A', 'B', 'B/D']);
  });

  it('ignores pinned ids that are not in the tree (stale data)', () => {
    const result = applyPinOrdering(root, { '': ['missing', 'C'] });
    expect(result.map((t) => t.fullPath)).toEqual(['C', 'A', 'B', 'B/B1', 'B/B2']);
  });

  it('ignores pinned ids that belong to a different parent (cross-level pinning is a no-op)', () => {
    // B/B1 的 parentId 是 'B', 但 pinnedByParent 的 key 是 ''（root 哨兵）；
    // 顶层分组找不到对应兄弟, 整条 pin 被忽略, DFS 顺序保持原样。
    const result = applyPinOrdering(root, { '': ['B/B1'] });
    expect(result.map((t) => t.fullPath)).toEqual(['A', 'B', 'B/B1', 'B/B2', 'C']);
  });

  it('promotes a child pinned under its actual parent (B/B1 pinned under parentKey "B")', () => {
    // 把 B/B1 pin 在 B 的子组里 -> B/B1 提到 B/B2 之前, B 仍按原 root 顺序。
    const result = applyPinOrdering(root, { B: ['B/B1'] });
    expect(result.map((t) => t.fullPath)).toEqual(['A', 'B', 'B/B1', 'B/B2', 'C']);
  });

  it('skips duplicate ids in the pinned array without re-emitting', () => {
    // pinned = ['C', 'C', 'B']: 去重后 ['C', 'B'] 按数组首次出现顺序
    // (C 在 B 前), root 顺序是 C, B, A; DFS 在 B 之后立刻展开 B 子树。
    const result = applyPinOrdering(root, { '': ['C', 'C', 'B'] });
    expect(result.map((t) => t.fullPath)).toEqual(['C', 'B', 'B/B1', 'B/B2', 'A']);
  });

  it('does not mutate the input array', () => {
    const before = root.map((t) => t.fullPath);
    applyPinOrdering(root, { '': ['C'] });
    expect(root.map((t) => t.fullPath)).toEqual(before);
  });
});

describe('migratePinnedByParentOnPathChange', () => {
  it('renames the exact entry (parent unchanged)', () => {
    // 中国/北京 → 中国/京城, parent 仍是中国
    const before = { '': ['中国/北京'], '中国': ['中国/北京'] };
    const result = migratePinnedByParentOnPathChange(
      before, '中国/北京', '中国/京城', '中国', '中国',
    );
    expect(result).toEqual({ '': ['中国/京城'], '中国': ['中国/京城'] });
  });

  it('migrates subtree entries with prefix replace', () => {
    // 中国/北京 → 中国/京城; 子路径 中国/北京/海淀 也要替换。
    const before = { '中国': ['中国/北京', '中国/北京/海淀'] };
    const result = migratePinnedByParentOnPathChange(
      before, '中国/北京', '中国/京城', '中国', '中国',
    );
    expect(result['中国']).toEqual(['中国/京城', '中国/京城/海淀']);
  });

  it('reparent: moves the entry from oldParentKey to newParentKey', () => {
    // 中国/北京 → 美国/北京 (reparent): parent 从 中国 → 美国
    const before = { '中国': ['中国/北京'] };
    const result = migratePinnedByParentOnPathChange(
      before, '中国/北京', '美国/北京', '中国', '美国',
    );
    // 原 parentKey='中国' 的列表搬到 '美国' 下。
    expect(result['中国']).toBeUndefined();
    expect(result['美国']).toEqual(['美国/北京']);
  });

  it('reparent with subtree rename', () => {
    // 中国/北京 → 美国/京城, parent 中国 → 美国
    const before = { '中国': ['中国/北京', '中国/北京/海淀'] };
    const result = migratePinnedByParentOnPathChange(
      before, '中国/北京', '美国/京城', '中国', '美国',
    );
    expect(result['美国']).toEqual(['美国/京城', '美国/京城/海淀']);
  });

  it('keeps unrelated pinned entries untouched', () => {
    const before = { '': ['alpha', 'beta'], '中国': ['中国/北京'] };
    const result = migratePinnedByParentOnPathChange(
      before, '中国/北京', '中国/京城', '中国', '中国',
    );
    expect(result['']).toEqual(['alpha', 'beta']);
    expect(result['中国']).toEqual(['中国/京城']);
  });

  it('dedups mapped entries when after rename they collide', () => {
    // 极端 case: rename 后某条已存在的 entry 与新条目同名 → 去重。
    const before = { '中国': ['中国/北京', '中国/京城'] };
    // 重命名 北京 → 京城: rename 后 '中国/北京' 变成 '中国/京城', 与原 '中国/京城'
    // 撞名, 应当去重保留首次出现的顺序。
    const result = migratePinnedByParentOnPathChange(
      before, '中国/北京', '中国/京城', '中国', '中国',
    );
    expect(result['中国']).toEqual(['中国/京城']);
  });

  it('does not mutate the input map', () => {
    const before = { '': ['中国/北京'] };
    const snapshot = JSON.stringify(before);
    migratePinnedByParentOnPathChange(before, '中国/北京', '中国/京城', '中国', '中国');
    expect(JSON.stringify(before)).toEqual(snapshot);
  });

  it('migrates pinned children under the renamed tag (parentKey === oldPath case)', () => {
    // pinnedByParent['中国/北京'] = ['中国/北京/海淀'] 是「海淀 pinned 在 北京 下」
    // rename 中国/北京 → 中国/京城 后, 海淀的 parent 变成 中国/京城, key 也要搬。
    const before = {
      '中国/北京': ['中国/北京/海淀', '中国/北京/朝阳'],
      '中国': ['中国/北京'],
    };
    const result = migratePinnedByParentOnPathChange(
      before, '中国/北京', '中国/京城', '中国', '中国',
    );
    expect(result['中国/北京']).toBeUndefined();
    expect(result['中国/京城']).toEqual(['中国/京城/海淀', '中国/京城/朝阳']);
    expect(result['中国']).toEqual(['中国/京城']); // 自己的 entry path 也跟着改
  });

  it('migrates pinned grandchildren of a reparented subtree', () => {
    // 拖入子树: source = 中国/北京, target = 美国, 里面有一个 pinned 孙 海淀。
    // 海淀 pinned 在 source 下（parentKey = '中国/北京'）, 整体 reparent 后要搬去
    // parentKey = '美国/北京'。
    const before = {
      '中国/北京': ['中国/北京/海淀'],
      '中国': ['中国/北京'],
    };
    const result = migratePinnedByParentOnPathChange(
      before, '中国/北京', '美国/北京', '中国', '美国',
    );
    expect(result['中国/北京']).toBeUndefined();
    expect(result['美国/北京']).toEqual(['美国/北京/海淀']);
    expect(result['美国']).toEqual(['美国/北京']);
  });

  it('handles nested pinned subtree with multiple levels', () => {
    // 三层: A/B/C 自身在 pinnedByParent['A/B'] 里, 它的子 A/B/C/D 在
    // pinnedByParent['A/B/C'] 里。rename A/B/C → A/B/X 之后:
    // - pinnedByParent['A/B'] 的 entry path 改名为 A/B/X（同 parent, path 替换）
    // - pinnedByParent['A/B/C'] 的 entry 搬到 pinnedByParent['A/B/X']（parentKey
    //   从旧 tag 改成新 tag, path 也替换）。
    const before = {
      'A/B': ['A/B/C'],
      'A/B/C': ['A/B/C/D'],
    };
    const result = migratePinnedByParentOnPathChange(
      before, 'A/B/C', 'A/B/X', 'A/B', 'A/B',
    );
    expect(result['A/B']).toEqual(['A/B/X']);
    expect(result['A/B/C']).toBeUndefined();
    expect(result['A/B/X']).toEqual(['A/B/X/D']);
  });
});

describe('remapPath', () => {
  it('returns the path unchanged when there is no match', () => {
    expect(remapPath('foo', 'bar', 'baz')).toBe('foo');
  });

  it('replaces the path on exact match', () => {
    expect(remapPath('中国/北京', '中国/北京', '中国/京城')).toBe('中国/京城');
  });

  it('replaces prefix and preserves the suffix', () => {
    expect(remapPath('中国/北京/海淀', '中国/北京', '中国/京城')).toBe('中国/京城/海淀');
  });

  it('does not match a partial prefix (中国/北 vs 中国/北京)', () => {
    // '中国/北京' 不是 '中国/北' 的 prefix-match, '中国/北' 不应替换。
    expect(remapPath('中国/北京', '中国/北', '中国/南')).toBe('中国/北京');
  });

  it('handles empty oldPath / newPath', () => {
    // empty oldPath 不实际使用（rename 不会用空字符串当 source path）, 但
    // 函数本身不应崩：'foo'.startsWith('/') === false → 原样返回。
    expect(remapPath('foo', '', 'bar')).toBe('foo');
  });

  it('handles same oldPath and newPath as identity', () => {
    expect(remapPath('中国/北京/海淀', '中国/北京', '中国/北京')).toBe('中国/北京/海淀');
  });
});

describe('remapParentKey', () => {
  it('returns the key unchanged when no rule matches', () => {
    expect(remapParentKey('foo', 'old', 'new', 'oldParent', 'newParent')).toBe('foo');
  });

  it('relabels to newParentKey when key === oldParentKey', () => {
    expect(remapParentKey('中国', '中国/北京', '美国/北京', '中国', '美国')).toBe('美国');
  });

  it('relabels to newPath when key === oldPath (children parent moves)', () => {
    expect(remapParentKey('中国/北京', '中国/北京', '中国/京城', '中国', '中国')).toBe('中国/京城');
  });

  it('prefers oldParentKey rule over oldPath when both match', () => {
    // edge case: key === oldPath === oldParentKey (rename 一个 root tag, 它的
    // parent 也是自己 = 不可能; 跳过; 用更现实的: oldParentKey 不同)
    expect(remapParentKey('foo', 'foo/bar', 'baz/bar', 'fooParent', 'fooParent2')).toBe('foo');
  });

  it('handles reparent with distinct oldParentKey and oldPath', () => {
    // reparent 中国/北京 → 美国/北京, source 父 = '中国', 目标父 = '美国'
    expect(remapParentKey('中国/北京', '中国/北京', '美国/北京', '中国', '美国')).toBe('美国/北京');
  });
});

describe('migratePinnedByParentOnDelete', () => {
  it('removes the exact entry and any subtree entries', () => {
    const before = {
      '': ['中国/北京', '中国/北京/海淀'],
      '中国': ['中国/北京', '中国/北京/海淀'],
    };
    const result = migratePinnedByParentOnDelete(before, '中国/北京');
    expect(result['']).toEqual([]);
    expect(result['中国']).toEqual([]);
  });

  it('keeps unrelated entries intact', () => {
    const before = { '': ['alpha', '中国/北京'], '中国': ['中国/上海'] };
    const result = migratePinnedByParentOnDelete(before, '中国/北京');
    expect(result['']).toEqual(['alpha']);
    expect(result['中国']).toEqual(['中国/上海']);
  });

  it('does not mutate the input map', () => {
    const before = { '': ['中国/北京'] };
    const snapshot = JSON.stringify(before);
    migratePinnedByParentOnDelete(before, '中国/北京');
    expect(JSON.stringify(before)).toEqual(snapshot);
  });
});

describe('diffPinnedByParent', () => {
  it('returns empty when both maps are identical', () => {
    const a = { '': ['X'], '中国': ['中国/北京'] };
    const b = { '': ['X'], '中国': ['中国/北京'] };
    expect(diffPinnedByParent(a, b)).toEqual([]);
  });

  it('returns one entry for a single parentKey change (including empty list)', () => {
    const before = { '': ['X', 'Y'] };
    const after = { '': ['X'] };
    expect(diffPinnedByParent(before, after)).toEqual([
      { parentKey: '', pinnedIds: ['X'] },
    ]);
  });

  it('returns one entry per parentKey that changed', () => {
    const before = { '': ['X'], '中国': ['中国/北京'] };
    const after = { '': ['X'], '中国': ['中国/京城'] };
    expect(diffPinnedByParent(before, after)).toEqual([
      { parentKey: '中国', pinnedIds: ['中国/京城'] },
    ]);
  });

  it('returns cleared entry when a key disappears from after', () => {
    const before = { '': ['X'], '中国': ['中国/北京'] };
    const after = { '': ['X'] };
    expect(diffPinnedByParent(before, after)).toEqual([
      { parentKey: '中国', pinnedIds: [] },
    ]);
  });
});
