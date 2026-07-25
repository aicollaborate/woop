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
