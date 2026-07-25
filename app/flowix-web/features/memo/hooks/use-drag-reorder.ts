import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';

// 通用拖拽重排状态机 ── 收敛 note-navigation-panel 里 tag / notebook 两套
// 几乎逐行对称的 pointerdown -> pointermove(阈值) -> pointerup(提交/选中)
// 逻辑。两套的差异只在三处回调上:
//   - findDropTarget: 命中测试 (tag 有 before/after/inside; notebook 只有 before/after)
//   - applyMove:      提交语义 (tag 的 inside 走 reparent IPC, before/after 改 layout;
//                     notebook 走 reorderNotebooks)
//   - onSelect:       未过阈值的 pointerup 视为点击 (tag 选中标签; notebook 切换笔记本)
// ghost / 行高亮等视觉由调用方自行渲染 (各自不同), hook 只暴露 draggingId /
// dropTarget / dragGhost 状态 + rowRefs + handlePointerDown。
//
// 与原内联实现的等价性: effect 依赖 [applyMove, findDropTarget, onSelect, threshold],
// 任一变更即重新订阅 window pointer 事件 ── 与原 [apply*Move, find*DropTarget, handle*]
// 完全对齐 (notebook 的 notebooks 依赖经由 applyNotebookMove/findNotebookDropTarget/
// handleNotebookRowActivate 的 useCallback 闭包间接捕获, 行为一致)。

export interface DragGhost {
  id: string;
  rect: DOMRect;
  currentX: number;
  currentY: number;
}

export interface DragDropTarget<TPosition extends string> {
  id: string;
  position: TPosition;
}

interface DragPointerState {
  sourceId: string;
  pointerId: number;
  startY: number;
  startX: number;
  rect: DOMRect | null;
  isDragging: boolean;
}

export interface UseDragReorderOptions<TPosition extends string> {
  /** 给定当前指针 y 与源 id, 返回 drop 目标 (id + position) 或 null。 */
  findDropTarget: (y: number, sourceId: string) => DragDropTarget<TPosition> | null;
  /** 拖动提交: 把 source 移到 target 的 position。 */
  applyMove: (sourceId: string, targetId: string, position: TPosition) => void;
  /** 未发生拖动 (pointerup 时位移未过阈值) 时, 视为点击选中 source。 */
  onSelect: (sourceId: string) => void;
  /** 进入拖动态的位移阈值 (px), 默认 4。 */
  threshold?: number;
}

export interface UseDragReorderResult<TPosition extends string> {
  draggingId: string | null;
  dropTarget: DragDropTarget<TPosition> | null;
  dragGhost: DragGhost | null;
  handlePointerDown: (e: ReactPointerEvent<HTMLDivElement>, id: string) => void;
}

/**
 * 位移是否超过拖拽阈值 ── dy 或 dx 任一达到 threshold 即视为开始拖动。
 * 原内联判断 `dy < threshold && dx < threshold` 的反向 (取反 = 任一达到)。
 * 抽出为纯函数便于单测阈值边界。
 */
export function hasExceededDragThreshold(
  dy: number,
  dx: number,
  threshold: number,
): boolean {
  return dy >= threshold || dx >= threshold;
}

export function useDragReorder<TPosition extends string>({
  findDropTarget,
  applyMove,
  onSelect,
  threshold = 4,
}: UseDragReorderOptions<TPosition>): UseDragReorderResult<TPosition> {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DragDropTarget<TPosition> | null>(null);
  const [dragGhost, setDragGhost] = useState<DragGhost | null>(null);
  const dragPointerRef = useRef<DragPointerState | null>(null);
  // 注: rowRefs 不在 hook 内创建 ── findDropTarget (由调用方传入) 需要在闭包
  // 里访问行 DOM, 而 findDropTarget 又是 hook 的入参, 若 rowRefs 由 hook 返回
  // 会形成循环依赖。rowRefs 由调用方自行 useRef 持有, hook 只管拖拽状态机。

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, id: string) => {
      if (e.button !== 0) return;
      // Prevent text selection while interacting with the row.
      e.preventDefault();
      const row = e.currentTarget;
      try {
        row.setPointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
      const rect = row.getBoundingClientRect();
      dragPointerRef.current = {
        sourceId: id,
        pointerId: e.pointerId,
        startY: e.clientY,
        startX: e.clientX,
        rect,
        isDragging: false,
      };
    },
    [],
  );

  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      const state = dragPointerRef.current;
      if (!state || state.pointerId !== e.pointerId) return;

      if (!state.isDragging) {
        const dy = Math.abs(e.clientY - state.startY);
        const dx = Math.abs(e.clientX - state.startX);
        if (!hasExceededDragThreshold(dy, dx, threshold)) return;
        state.isDragging = true;
        setDraggingId(state.sourceId);
        if (state.rect) {
          setDragGhost({
            id: state.sourceId,
            rect: state.rect,
            currentX: e.clientX,
            currentY: e.clientY,
          });
        }
      } else {
        setDragGhost((prev) => (prev ? { ...prev, currentX: e.clientX, currentY: e.clientY } : null));
      }

      setDropTarget(findDropTarget(e.clientY, state.sourceId));
    };

    const handleUp = (e: PointerEvent) => {
      const state = dragPointerRef.current;
      if (!state || state.pointerId !== e.pointerId) return;

      if (state.isDragging) {
        const target = findDropTarget(e.clientY, state.sourceId);
        if (target) {
          applyMove(state.sourceId, target.id, target.position);
        }
      } else {
        // 没有位移, 视为普通点击 -> 选中。
        onSelect(state.sourceId);
      }

      dragPointerRef.current = null;
      setDraggingId(null);
      setDragGhost(null);
      setDropTarget(null);
    };

    const handleCancel = (e: PointerEvent) => handleUp(e);

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleCancel);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleCancel);
    };
  }, [applyMove, findDropTarget, onSelect, threshold]);

  return { draggingId, dropTarget, dragGhost, handlePointerDown };
}
