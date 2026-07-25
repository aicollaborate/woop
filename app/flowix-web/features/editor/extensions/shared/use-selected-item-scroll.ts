import { useLayoutEffect, useRef } from 'react';
import {
  scrollSelectedItemIntoView,
} from '@features/editor/extensions/shared/scroll-selected-item';

interface UseSelectedItemScrollOptions<Item> {
  items: Item[];
  selectedIndex: number;
  scrollSelectedItem?: boolean;
}

export function useSelectedItemScroll<Item>({
  items,
  selectedIndex,
  scrollSelectedItem = true,
}: UseSelectedItemScrollOptions<Item>) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // 键盘上下键移动 selectedIndex 后, 仅在当前 item 即将离开弹窗内部
  // 视口时滚动一次; 滚动发生时尽量把 item 放到顶部下方 20px。
  // items 也进依赖: 过滤导致列表换血时, 即使 selectedIndex 没变
  // 也需要重新评估 (新列表里 selectedIndex 可能对应不同位置的 item)。
  useLayoutEffect(() => {
    if (!scrollSelectedItem) return;

    const item = itemRefs.current[selectedIndex];
    const scroller = scrollerRef.current;
    if (!item || !scroller) return;

    scrollSelectedItemIntoView(scroller, item);
  }, [selectedIndex, items, scrollSelectedItem]);

  return { scrollerRef, itemRefs };
}
