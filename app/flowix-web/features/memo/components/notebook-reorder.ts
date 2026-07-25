// NotebookList 拖拽重排的纯逻辑 ── 从组件抽出便于单测。
// 组件只负责 DOM 命中测试 (getBoundingClientRect) + 调 store IPC,
// 位置判定与索引算术集中在此。

export type NotebookDropPosition = 'before' | 'after';

/**
 * 笔记本行落点位置 ── 指针在行上半部分为 'before', 下半部分为 'after'。
 * 与原内联逻辑等价: `y - rect.top < rect.height / 2 ? 'before' : 'after'`。
 */
export function computeNotebookDropPosition(
  y: number,
  rectTop: number,
  rectHeight: number,
): NotebookDropPosition {
  return y - rectTop < rectHeight / 2 ? 'before' : 'after';
}

/**
 * 计算笔记本拖拽重排后的 id 序列。纯函数, 不触碰 store/IPC。
 *
 * 索引校正: source 被 splice 移除后, targetIndex 仍是「原列表里的位置」,
 * 若 source 原本在 target 之前 (sourceIndex < targetIndex), 移除 source
 * 后 target 实际前移了一位, 故 insertAt = targetIndex - 1。 'after' 再 +1。
 * 最后 clamp 到 [0, len]。
 *
 * 无效输入 (source === target / 找不到) 原样返回同一数组引用, 调用方据此
 * 跳过持久化。
 */
export function reorderNotebookIds(
  ids: string[],
  sourceId: string,
  targetId: string,
  position: NotebookDropPosition,
): string[] {
  if (sourceId === targetId) return ids;
  const sourceIndex = ids.indexOf(sourceId);
  const targetIndex = ids.indexOf(targetId);
  if (sourceIndex < 0 || targetIndex < 0) return ids;
  const next = ids.slice();
  const [moved] = next.splice(sourceIndex, 1);
  // source 已经在 splice 里被移除; 之后 targetIndex 是「在原列表
  // 里的位置」(对 source 位置之后的 target 没校正, 故需再减 1)。
  let insertAt = targetIndex;
  if (sourceIndex < targetIndex) insertAt = targetIndex - 1;
  if (position === 'after') insertAt += 1;
  insertAt = Math.max(0, Math.min(insertAt, next.length));
  next.splice(insertAt, 0, moved);
  return next;
}
