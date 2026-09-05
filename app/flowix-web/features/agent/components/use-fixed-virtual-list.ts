import { useCallback, useLayoutEffect, useMemo, useState, type RefObject, type UIEvent } from 'react';

export interface FixedVirtualListItem {
  key: string;
  size: number;
}

export interface FixedVirtualItem<T extends FixedVirtualListItem> {
  index: number;
  item: T;
  start: number;
  size: number;
}

interface FixedVirtualListOptions {
  overscan?: number;
}

function firstVisibleIndex(
  offsets: readonly number[],
  sizes: readonly number[],
  scrollTop: number,
): number {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle] + sizes[middle] <= scrollTop) low = middle + 1;
    else high = middle;
  }
  return low;
}

function firstIndexAtOrAfter(
  offsets: readonly number[],
  value: number,
): number {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * A small fixed-size virtualizer for dense navigation lists.
 *
 * The list owns its scroll element, while this hook only tracks viewport
 * geometry and computes a bounded render window. Keeping it headless avoids a
 * dependency for one fixed-height list and lets callers preserve their
 * existing scroll container, portals, and interaction markup.
 */
export function useFixedVirtualList<T extends FixedVirtualListItem>(
  items: readonly T[],
  scrollerRef: RefObject<HTMLDivElement | null>,
  options: FixedVirtualListOptions = {},
): {
  totalSize: number;
  virtualItems: readonly FixedVirtualItem<T>[];
  onScroll: (event: UIEvent<HTMLDivElement>) => void;
} {
  const overscan = options.overscan ?? 6;
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);

  const layout = useMemo(() => {
    const offsets: number[] = [];
    const sizes: number[] = [];
    let totalSize = 0;
    for (const item of items) {
      offsets.push(totalSize);
      sizes.push(item.size);
      totalSize += item.size;
    }
    return { offsets, sizes, totalSize };
  }, [items]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return undefined;

    const updateViewport = () => {
      setViewportHeight(scroller.clientHeight);
      setScrollTop(scroller.scrollTop);
    };
    updateViewport();

    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(updateViewport);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scrollerRef]);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    // Filtering, archiving, or deleting conversations can shrink the content
    // below the current scrollTop. Clamp before the next paint so the binary
    // search cannot select an out-of-range window and leave only the last row
    // rendered while the browser is deciding whether to clamp itself.
    const maxScrollTop = Math.max(0, layout.totalSize - scroller.clientHeight);
    if (scroller.scrollTop > maxScrollTop) {
      scroller.scrollTop = maxScrollTop;
    }
    setScrollTop(scroller.scrollTop);
    setViewportHeight(scroller.clientHeight);
  }, [layout.totalSize, scrollerRef]);

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
    setViewportHeight(event.currentTarget.clientHeight);
  }, []);

  const virtualItems = useMemo(() => {
    if (items.length === 0) return [];

    const visibleStart = firstVisibleIndex(layout.offsets, layout.sizes, scrollTop);
    const visibleEnd = firstIndexAtOrAfter(
      layout.offsets,
      scrollTop + Math.max(viewportHeight, 1),
    );
    const start = Math.max(0, Math.min(items.length - 1, visibleStart - overscan));
    const end = Math.min(items.length, Math.max(start + 1, visibleEnd + overscan));

    return items.slice(start, end).map((item, offset) => {
      const index = start + offset;
      return {
        index,
        item,
        start: layout.offsets[index],
        size: layout.sizes[index],
      };
    });
  }, [items, layout, overscan, scrollTop, viewportHeight]);

  return { totalSize: layout.totalSize, virtualItems, onScroll };
}
