// TagTree 拖拽重排 / 子树 / 布局重建的纯逻辑 ── 从组件抽出便于单测。
// 组件只负责 DOM 命中测试 + IPC (inside reparent) + store 写入,
// 位置判定 / 子树计算 / 同级排序 / segment 树重建集中在此。
//
// 注: 'inside' (reparent) 走 move_memo_tag IPC, 不是纯函数, 留在组件里。

import type {
  MemoTagLayoutItem,
  MemoTagTreeItem,
} from '@features/memo/services/memo-list-metadata-service';

export type TagDropPosition = 'before' | 'after' | 'inside';

/**
 * 标签行落点位置 ── 上 1/3 'before', 下 1/3 'after', 中间 1/3 'inside'。
 * 与原内联逻辑等价。
 */
export function computeTagDropPosition(
  relativeY: number,
  rectHeight: number,
): TagDropPosition {
  return relativeY < rectHeight / 3
    ? 'before'
    : relativeY > (rectHeight * 2) / 3
      ? 'after'
      : 'inside';
}

/**
 * 取 source 整棵子树 id (含自身)。子树 = source 之后、depth 仍 > sourceDepth
 * 的连续节点; 遇到 depth <= sourceDepth 即子树结束。
 */
export function getSubtreeIds(
  tagOptions: MemoTagTreeItem[],
  sourceId: string,
): string[] {
  const sourceIndex = tagOptions.findIndex((tag) => tag.id === sourceId);
  if (sourceIndex < 0) return [];
  const sourceDepth = tagOptions[sourceIndex].depth;
  const ids = [sourceId];
  for (let index = sourceIndex + 1; index < tagOptions.length; index += 1) {
    if (tagOptions[index].depth <= sourceDepth) break;
    ids.push(tagOptions[index].id);
  }
  return ids;
}

/**
 * 从 layout (真实 tag fullPath 顺序列表) 重建 segment 节点树, 用于拖拽后
 * 立刻重渲染 (不重新触发 IPC)。与 [memo-list-metadata-service] 的
 * buildTagTreeOptions 同源 ── 路径拆 segment、同 fullPath 合并、parent
 * 由字面推导。count 复用当前 tagOptions (按 fullPath 取), 避免重算。
 *
 * 必须按 layout 顺序 ensureSegment, 否则 layout 顺序被忽略, 拖动后 UI 不变
 * (要等 reload 走 buildTagTreeOptions 才生效)。
 */
export function rebuildTagOptionsFromLayout(
  layout: MemoTagLayoutItem[],
  tagOptions: MemoTagTreeItem[],
): MemoTagTreeItem[] {
  const segmentByFullPath = new Map<
    string,
    { name: string; fullPath: string; depth: number; count: number }
  >();

  const countByFullPath = new Map(tagOptions.map((seg) => [seg.fullPath, seg.count]));

  const ensureSegment = (fullPath: string) => {
    if (segmentByFullPath.has(fullPath)) return;
    const lastSlash = fullPath.lastIndexOf('/');
    if (lastSlash > 0) {
      ensureSegment(fullPath.slice(0, lastSlash));
    }
    const name = lastSlash > 0 ? fullPath.slice(lastSlash + 1) : fullPath;
    const depthFromSlashes = (fullPath.match(/\//g) ?? []).length;
    segmentByFullPath.set(fullPath, {
      name,
      fullPath,
      depth: depthFromSlashes,
      count: countByFullPath.get(fullPath) ?? 0,
    });
  };

  // 按 layout 顺序展开: segment 节点顺序 = layout 顺序 (同级 reorder 立即生效)。
  for (const item of layout) {
    ensureSegment(item.id);
  }

  const childrenByParent = new Map<string | null, string[]>();
  for (const fullPath of segmentByFullPath.keys()) {
    const lastSlash = fullPath.lastIndexOf('/');
    const parentFullPath = lastSlash > 0 ? fullPath.slice(0, lastSlash) : null;
    const arr = childrenByParent.get(parentFullPath) ?? [];
    arr.push(fullPath);
    childrenByParent.set(parentFullPath, arr);
  }

  const result: MemoTagTreeItem[] = [];
  const visit = (fullPath: string) => {
    const seg = segmentByFullPath.get(fullPath)!;
    const lastSlash = fullPath.lastIndexOf('/');
    const parentFullPath = lastSlash > 0 ? fullPath.slice(0, lastSlash) : null;
    result.push({
      id: fullPath,
      parentId: parentFullPath,
      name: seg.name,
      fullPath,
      depth: seg.depth,
      count: seg.count,
    });
    for (const child of childrenByParent.get(fullPath) ?? []) {
      visit(child);
    }
  };

  for (const root of childrenByParent.get(null) ?? []) {
    visit(root);
  }
  return result;
}

/**
 * 'before' / 'after' 同级重排 (纯 UI 排序, 持久化到 tagLayout)。
 * 返回新的 layout, 或 null 表示无效 (source 子树为空 / target 在 source
 * 子树内 / target 不在 layout 中) ── 调用方据此跳过。
 *
 * currentLayout 推导: 优先用已有 tagLayout, 为空则从 tagOptions 现场派生
 * ({id, parentId})。
 */
export function reorderTagLayout(
  tagLayout: MemoTagLayoutItem[],
  tagOptions: MemoTagTreeItem[],
  sourceId: string,
  targetId: string,
  position: 'before' | 'after',
): MemoTagLayoutItem[] | null {
  const currentLayout: MemoTagLayoutItem[] = tagLayout.length > 0
    ? tagLayout
    : tagOptions.map(({ id, parentId }) => ({ id, parentId }));
  const sourceSubtreeIds = getSubtreeIds(tagOptions, sourceId);
  if (sourceSubtreeIds.length === 0 || sourceSubtreeIds.includes(targetId)) return null;

  const movingItems = currentLayout.filter((item) => sourceSubtreeIds.includes(item.id));
  const remaining = currentLayout.filter((item) => !sourceSubtreeIds.includes(item.id));

  let insertIndex = remaining.length;
  const targetIndex = remaining.findIndex((item) => item.id === targetId);
  if (targetIndex < 0) return null;
  if (position === 'before') {
    insertIndex = targetIndex;
  } else {
    const targetSubtreeIds = getSubtreeIds(tagOptions, targetId).filter(
      (id) => !sourceSubtreeIds.includes(id),
    );
    const lastTargetSubtreeId = targetSubtreeIds[targetSubtreeIds.length - 1] ?? targetId;
    insertIndex = remaining.findIndex((item) => item.id === lastTargetSubtreeId) + 1;
  }

  return [
    ...remaining.slice(0, insertIndex),
    ...movingItems,
    ...remaining.slice(insertIndex),
  ];
}

/**
 * 应用 pinned 排序: 以 DFS 走树, 同一 parent 下的 pinned 列表 (MRU 顺序)
 * 提到兄弟组最前, 其余兄弟按原 layout 顺序排在后面。
 *
 * 约定:
 * - `pinnedByParent` 的 key = parent fullPath, root 用 `""` (空字符串)。
 * - 调用方需保证 pinned 数组内 id 已去重; 本函数不主动去重, 但容错: 重复项
 *   会被去重, 不会重复渲染。
 * - pinned 列表里指向不存在 tag / 跨 parent 的 id 静默跳过 ── 用不到就丢
 *   弃, 与 buildTagTreeOptions 的语义对齐。
 * - 不修改 `tagOptions` 的 `parentId` / `depth` / `id`, 仅重排数组顺序。
 * - 走 DFS 而非线性按 parentId 分组: 线性分组会把 root 兄弟组的后段 (e.g. C)
 *   插到 B 的子树 (B/B1, B/B2) 之前, 破坏嵌套结构。
 *
 * 之所以把排序做成纯函数 (而非熏进 `buildTagTreeOptions`): buildTagTree 推导
 * 父子关系靠 layout + fullPath 字面, 而 pinned 是另一维度; 拆开更易测, 也能
 * 在 tagged rename / delete / reparent 迁移后不重走 layout 推导直接复用。
 */
export function applyPinOrdering(
  tagOptions: MemoTagTreeItem[],
  pinnedByParent: Readonly<Record<string, readonly string[]>>,
): MemoTagTreeItem[] {
  if (Object.keys(pinnedByParent).length === 0) return tagOptions;

  const childrenByParent = new Map<string | null, MemoTagTreeItem[]>();
  for (const tag of tagOptions) {
    const arr = childrenByParent.get(tag.parentId) ?? [];
    arr.push(tag);
    childrenByParent.set(tag.parentId, arr);
  }

  const result: MemoTagTreeItem[] = [];
  const visit = (parentId: string | null): void => {
    const children = childrenByParent.get(parentId);
    if (!children || children.length === 0) return;
    const parentKey = parentId ?? '';
    const pinned = pinnedByParent[parentKey];
    const pinnedSet = pinned && pinned.length > 0 ? new Set(pinned) : null;
    const emitted = new Set<string>();

    // 1. pinned 按 MRU 顺序, 同时进入子节点递归 (递归里 pinned 仍生效)。
    if (pinned) {
      for (const fullPath of pinned) {
        if (emitted.has(fullPath)) continue;
        const seg = children.find((s) => s.fullPath === fullPath);
        if (!seg) continue; // 跨 parent / 不存在 → 跳过
        result.push(seg);
        emitted.add(fullPath);
        visit(seg.fullPath);
      }
    }
    // 2. 非 pinned 保持原 layout 顺序; 同理递归进入子节点。
    for (const seg of children) {
      if (pinnedSet?.has(seg.fullPath)) continue;
      result.push(seg);
      visit(seg.fullPath);
    }
  };

  visit(null);
  return result;
}

/**
 * 检查两个数组内容是否一致（顺序也要一致）。用于 diff pinned 列表变化。
 */
function pinnedListEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * 把单个 tag fullPath 应用「oldPath → newPath 的 prefix-replace」替换：
 * - 自身匹配 oldPath → newPath
 * - 以 oldPath + '/' 起头 → newPath + 原 suffix
 * - 其他 → 原样
 *
 * 不变异入参; 调用方需自行去重。
 */
export function remapPath(path: string, oldPath: string, newPath: string): string {
  if (path === oldPath) return newPath;
  if (path.startsWith(`${oldPath}/`)) {
    return `${newPath}${path.slice(oldPath.length)}`;
  }
  return path;
}

/**
 * 把 parentKey 应用 rename / reparent 后的位置迁移：
 * - 等于 oldParentKey → newParentKey（被改名 tag 的直接父级; rename 时二
 *   者相等, 相当于原地不动; reparent 时 source 整体搬到 target 之下）
 * - 等于 oldPath → newPath（被改名 tag 自身作为 parentKey, 其 pinned 子节
 *   点的 parent = 旧 tag, rename 后 parent = 新 tag; reparent 同理）
 * - 其他 → 原样
 *
 * 「对 path 和 parentKey 都跑同一个前缀替换」是这个函数的本质 ── 不变量是
 * `parentKey(childPath) === remapParentKey(parentKey, ...)` 同步迁移。
 */
export function remapParentKey(
  key: string,
  oldPath: string,
  newPath: string,
  oldParentKey: string,
  newParentKey: string,
): string {
  if (key === oldParentKey) return newParentKey;
  if (key === oldPath) return newPath;
  return key;
}

/**
 * 在 tag 路径变化（rename / reparent）后迁移 pinnedByParent。
 *
 * 整体策略：对每个 parentKey 跑 `remapParentKey`, 对每个 list item 跑
 * `remapPath`, 然后按去重后的 target key 写入结果。详细规则见
 * `remapParentKey` / `remapPath` 的注释。
 *
 * 返回**新对象**（不变异入参）。当 oldPath === newPath 且 oldParentKey ===
 * newParentKey 时返回入参的浅拷贝（无变化但保持 immutability 期望）。
 */
export function migratePinnedByParentOnPathChange(
  pinnedByParent: Readonly<Record<string, string[]>>,
  oldPath: string,
  newPath: string,
  oldParentKey: string,
  newParentKey: string,
): Record<string, string[]> {
  if (oldPath === newPath && oldParentKey === newParentKey) {
    return { ...pinnedByParent };
  }
  const result: Record<string, string[]> = {};
  for (const [parentKey, list] of Object.entries(pinnedByParent)) {
    const targetKey = remapParentKey(
      parentKey, oldPath, newPath, oldParentKey, newParentKey,
    );
    const seen = new Set<string>();
    const mapped: string[] = [];
    for (const item of list) {
      const next = remapPath(item, oldPath, newPath);
      if (seen.has(next)) continue;
      seen.add(next);
      mapped.push(next);
    }
    if (targetKey in result) {
      // 极少见：同一次迁移中两个 key 合并到同一目标（rename 让两条父链
      // 重合）；按去重 + 原有顺序合并。
      const merged: string[] = [];
      const seenMerged = new Set<string>();
      for (const item of [...result[targetKey], ...mapped]) {
        if (seenMerged.has(item)) continue;
        seenMerged.add(item);
        merged.push(item);
      }
      result[targetKey] = merged;
    } else {
      result[targetKey] = mapped;
    }
  }
  return result;
}

/**
 * 在 tag 删除后清理 pinnedByParent：移除任何等于 tagPath 或以 tagPath/ 起
 * 头的 pinned 条目。返回新对象；即便某 parentKey 列表清空也保留 key + 空
 * 数组，让持久化层落盘时清理该 key。
 */
export function migratePinnedByParentOnDelete(
  pinnedByParent: Readonly<Record<string, string[]>>,
  tagPath: string,
): Record<string, string[]> {
  const prefix = `${tagPath}/`;
  const result: Record<string, string[]> = {};
  for (const [parentKey, list] of Object.entries(pinnedByParent)) {
    result[parentKey] = list.filter(
      (item) => item !== tagPath && !item.startsWith(prefix),
    );
  }
  return result;
}

/**
 * Diff 两份 pinnedByParent，给出需要持久化到后端的 parentKey 列表
 * （含「清空」语义）。返回 [{ parentKey, pinnedIds }]，调用方挨个调
 * `system.setTagPinned(notebookId, parentKey, pinnedIds)`。
 */
export function diffPinnedByParent(
  before: Readonly<Record<string, string[]>>,
  after: Readonly<Record<string, string[]>>,
): Array<{ parentKey: string; pinnedIds: string[] }> {
  const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
  const changes: Array<{ parentKey: string; pinnedIds: string[] }> = [];
  for (const key of keys) {
    const beforeList = before[key] ?? [];
    const afterList = after[key] ?? [];
    if (pinnedListEqual(beforeList, afterList)) continue;
    changes.push({ parentKey: key, pinnedIds: afterList });
  }
  return changes;
}
