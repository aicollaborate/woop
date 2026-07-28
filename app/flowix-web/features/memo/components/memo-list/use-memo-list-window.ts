import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type RefObject,
  type UIEvent,
} from 'react';

import type { ColorFilterValue, MemoItem } from '@features/memo';

const INITIAL_RENDER_COUNT = 120;
const RENDER_BATCH_SIZE = 80;
const LOAD_MORE_THRESHOLD_PX = 720;

interface MemoListWindowOptions {
  memos: MemoItem[];
  activeFilter: string;
  colorFilter: ColorFilterValue;
  selectedMemoId?: string;
  queryKey: string;
  loading: boolean;
  scrollerRef: RefObject<HTMLDivElement | null>;
}

/**
 * Owns the memo list's incremental rendering window.
 *
 * This deliberately uses a growing prefix rather than a virtual list: memo
 * cards have dynamic heights and entrance animations, so keeping mounted rows
 * stable is more important than aggressively recycling DOM nodes.
 */
export function useMemoListWindow({
  memos,
  activeFilter,
  colorFilter,
  selectedMemoId,
  queryKey,
  loading,
  scrollerRef,
}: MemoListWindowOptions) {
  const [visibleCount, setVisibleCount] = useState(INITIAL_RENDER_COUNT);

  const filteredMemos = useMemo(() => {
    if (activeFilter !== 'color') return memos;
    if (colorFilter === 'any') {
      return memos.filter((memo) => memo.colors.length > 0);
    }
    if (colorFilter === 'none') {
      return memos.filter((memo) => memo.colors.length === 0);
    }
    return memos.filter((memo) => memo.colors.includes(colorFilter));
  }, [activeFilter, colorFilter, memos]);

  const selectedIndex = useMemo(
    () =>
      selectedMemoId
        ? filteredMemos.findIndex((memo) => memo.id === selectedMemoId)
        : -1,
    [filteredMemos, selectedMemoId],
  );
  const minimumVisibleCount =
    selectedIndex >= 0
      ? Math.max(INITIAL_RENDER_COUNT, selectedIndex + 1)
      : INITIAL_RENDER_COUNT;
  const normalizedVisibleCount = Math.min(
    filteredMemos.length,
    Math.max(visibleCount, minimumVisibleCount),
  );
  const renderedMemos = useMemo(
    () => filteredMemos.slice(0, normalizedVisibleCount),
    [filteredMemos, normalizedVisibleCount],
  );
  const hasMoreMemos = normalizedVisibleCount < filteredMemos.length;

  useEffect(() => {
    setVisibleCount(minimumVisibleCount);
  }, [minimumVisibleCount, queryKey]);

  const loadMore = useCallback(() => {
    setVisibleCount((count) =>
      Math.min(
        filteredMemos.length,
        Math.max(count, minimumVisibleCount) + RENDER_BATCH_SIZE,
      ),
    );
  }, [filteredMemos.length, minimumVisibleCount]);

  const onScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      if (!hasMoreMemos) return;
      const scroller = event.currentTarget;
      const distanceToBottom =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      if (distanceToBottom <= LOAD_MORE_THRESHOLD_PX) {
        loadMore();
      }
    },
    [hasMoreMemos, loadMore],
  );

  useLayoutEffect(() => {
    if (loading || !hasMoreMemos) return;
    const scroller = scrollerRef.current;
    if (
      scroller &&
      scroller.scrollHeight - scroller.clientHeight <= LOAD_MORE_THRESHOLD_PX
    ) {
      loadMore();
    }
  }, [hasMoreMemos, loadMore, loading, normalizedVisibleCount, scrollerRef]);

  return {
    filteredMemos,
    renderedMemos,
    hasMoreMemos,
    onScroll,
  };
}
