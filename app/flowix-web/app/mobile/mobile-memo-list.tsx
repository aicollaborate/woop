import { BookOpenText, LoaderCircle } from 'lucide-react';
import { PushPinIcon, TrashSimpleIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';

import { assetUrl, decodeStorageKey } from '@features/editor/extensions/attachment-link/utils';
import { mobileClient } from '@platform/tauri/mobile-client';
import type { MemoItem } from '@/types/memo-item';

const PULL_REFRESH_THRESHOLD = 56;
const PULL_MAX_DISTANCE = 84;
const SWIPE_ACTIONS_WIDTH = 108;
const SWIPE_ACTIVATION_DISTANCE = 10;
const SWIPE_COMMIT_DISTANCE = 48;
const SWIPE_VELOCITY_THRESHOLD = 0.45;
const SWIPE_MAX_OVERSHOOT = 24;
const SWIPE_SETTLE_DURATION = 220;

type SwipeLock = 'undecided' | 'horizontal' | 'vertical';

interface SwipeGesture {
  pointerId: number;
  startX: number;
  startY: number;
  baseOffset: number;
  offset: number;
  lastX: number;
  lastTime: number;
  velocityX: number;
  lock: SwipeLock;
}

interface MobileMemoListProps {
  items: MemoItem[];
  loading: boolean;
  onRefresh: () => void | Promise<void>;
  onOpen: (id: string) => void;
  openMemoId: string | null;
  onToggleActions: (id: string) => void;
  onDelete: (id: string) => void;
  onTogglePin: (memo: MemoItem) => void;
  searchQuery?: string;
  searching?: boolean;
}

function noteTitle(filename: string): string {
  return filename.replace(/\.(?:md|markdown)$/i, '') || '未命名笔记';
}

function relativeTime(timestamp: number): string {
  const delta = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days} 天前` : new Date(timestamp).toLocaleDateString();
}

function thumbnailSrc(thumbnail: string | null | undefined): string | null {
  if (!thumbnail) return null;
  const storageKey = decodeStorageKey(thumbnail);
  return storageKey ? assetUrl(storageKey) : thumbnail;
}

function MobileMemoRow({
  memo,
  onOpen,
  actionsOpen,
  onToggleActions,
  onDelete,
  onTogglePin,
}: {
  memo: MemoItem;
  onOpen: (id: string) => void;
  actionsOpen: boolean;
  onToggleActions: (id: string) => void;
  onDelete: (id: string) => void;
  onTogglePin: (memo: MemoItem) => void;
}) {
  const previewImage = thumbnailSrc(memo.thumbnail);
  const rowRef = useRef<HTMLButtonElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<SwipeGesture | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const interactingRef = useRef(false);

  const clearSettleTimer = () => {
    if (settleTimerRef.current === null) return;
    window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = null;
  };

  const setVisualOffset = (offset: number) => {
    rowRef.current?.style.setProperty('--mobile-memo-row-offset', `${offset}px`);
    const actionProgress = Math.min(1, Math.max(0, -Math.min(offset, 0) / SWIPE_ACTIONS_WIDTH));
    shellRef.current?.style.setProperty('--mobile-memo-row-action-progress', `${actionProgress}`);
  };

  const clearInteraction = () => {
    gestureRef.current = null;
    shellRef.current?.removeAttribute('data-swiping');
    shellRef.current?.removeAttribute('data-settling');
    shellRef.current?.style.removeProperty('--mobile-memo-row-action-progress');
    rowRef.current?.style.removeProperty('--mobile-memo-row-offset');
    interactingRef.current = false;
  };

  const rubberBandOffset = (offset: number) => {
    if (offset > 0) return Math.min(offset * 0.2, SWIPE_MAX_OVERSHOOT);
    if (offset < -SWIPE_ACTIONS_WIDTH) {
      return Math.max(-SWIPE_ACTIONS_WIDTH - (Math.abs(offset) - SWIPE_ACTIONS_WIDTH) * 0.2, -SWIPE_ACTIONS_WIDTH - SWIPE_MAX_OVERSHOOT);
    }
    return offset;
  };

  const settle = (targetOpen: boolean, currentOffset: number) => {
    const row = rowRef.current;
    const shell = shellRef.current;
    if (!row || !shell) return;

    clearSettleTimer();
    interactingRef.current = true;
    shell.removeAttribute('data-swiping');
    shell.setAttribute('data-settling', 'true');
    setVisualOffset(currentOffset);
    // Flush the finger position while transitions are disabled, then animate
    // to the resting position. This makes release feel like a native snap,
    // including when the user releases outside the commit threshold.
    row.getBoundingClientRect();
    setVisualOffset(targetOpen ? -SWIPE_ACTIONS_WIDTH : 0);
    if (targetOpen !== actionsOpen) onToggleActions(memo.id);

    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      row.style.removeProperty('--mobile-memo-row-offset');
      shell.style.removeProperty('--mobile-memo-row-action-progress');
      shell.removeAttribute('data-settling');
      interactingRef.current = false;
    }, SWIPE_SETTLE_DURATION);
  };

  useEffect(() => () => {
    clearSettleTimer();
  }, []);

  useEffect(() => {
    // The class is the source of truth when the row is idle. During a gesture
    // or snap animation the inline variable owns the intermediate position.
    if (!interactingRef.current) rowRef.current?.style.removeProperty('--mobile-memo-row-offset');
  }, [actionsOpen]);

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    clearSettleTimer();
    interactingRef.current = true;
    shellRef.current?.removeAttribute('data-settling');
    setVisualOffset(actionsOpen ? -SWIPE_ACTIONS_WIDTH : 0);
    const now = performance.now();
    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseOffset: actionsOpen ? -SWIPE_ACTIONS_WIDTH : 0,
      offset: actionsOpen ? -SWIPE_ACTIONS_WIDTH : 0,
      lastX: event.clientX,
      lastTime: now,
      velocityX: 0,
      lock: 'undecided',
    };
    suppressClickRef.current = false;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;

    if (gesture.lock === 'undecided') {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_ACTIVATION_DISTANCE) return;
      if (Math.abs(dy) > Math.abs(dx) * 1.2) {
        gesture.lock = 'vertical';
        suppressClickRef.current = true;
        clearInteraction();
        return;
      }
      if (Math.abs(dx) <= Math.abs(dy) * 1.2) return;
      gesture.lock = 'horizontal';
      shellRef.current?.setAttribute('data-swiping', 'true');
    }
    if (gesture.lock !== 'horizontal') return;

    event.preventDefault();
    const now = performance.now();
    const elapsed = now - gesture.lastTime;
    if (elapsed > 0) gesture.velocityX = (event.clientX - gesture.lastX) / elapsed;
    gesture.lastX = event.clientX;
    gesture.lastTime = now;
    gesture.offset = rubberBandOffset(gesture.baseOffset + dx);
    setVisualOffset(gesture.offset);
  };
  const handlePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.lock !== 'horizontal') {
      if (gesture.lock === 'vertical') suppressClickRef.current = true;
      clearInteraction();
      return;
    }

    event.preventDefault();
    const dx = event.clientX - gesture.startX;
    const projectedDx = dx + (Math.abs(gesture.velocityX) >= SWIPE_VELOCITY_THRESHOLD ? gesture.velocityX * 80 : 0);
    const targetOpen = actionsOpen
      ? projectedDx < SWIPE_COMMIT_DISTANCE
      : projectedDx < -SWIPE_COMMIT_DISTANCE;
    suppressClickRef.current = true;
    settle(targetOpen, rubberBandOffset(gesture.baseOffset + dx));
    gestureRef.current = null;
  };

  const handlePointerCancel = (event: React.PointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    suppressClickRef.current = gesture.lock === 'horizontal';
    if (gesture.lock === 'horizontal') settle(actionsOpen, gesture.offset);
    else clearInteraction();
    gestureRef.current = null;
  };

  return (
    <div ref={shellRef} className={`mobile-memo-row-shell${actionsOpen ? ' is-actions-open' : ''}`}>
      <div className="mobile-memo-row-actions" aria-label="笔记操作">
        <button
          type="button"
          className="mobile-memo-row-action mobile-memo-row-action--pin"
          aria-label={memo.favorited ? '取消置顶' : '置顶'}
          title={memo.favorited ? '取消置顶' : '置顶'}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); onTogglePin(memo); }}
        >
          <PushPinIcon size={18} weight={memo.favorited ? 'fill' : 'regular'} />
        </button>
        <button
          type="button"
          className="mobile-memo-row-action mobile-memo-row-action--delete"
          aria-label="删除"
          title="删除"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); onDelete(memo.id); }}
        >
          <TrashSimpleIcon size={18} weight="regular" />
        </button>
      </div>
      <button
        type="button"
        ref={rowRef}
        className="mobile-memo-row"
        aria-expanded={actionsOpen}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onClick={(event) => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            event.preventDefault();
            return;
          }
          onOpen(memo.id);
        }}
      >
        <div className="mobile-memo-row__content">
        <div className="mobile-memo-row__title">
          <strong>{noteTitle(memo.filename)}</strong>
        </div>
        <p>{memo.preview || '记录自己的想法'}</p>
        {previewImage && (
          <img
            className="mobile-memo-row__thumbnail"
            src={previewImage}
            alt=""
            loading="lazy"
            draggable={false}
            onError={(event) => { event.currentTarget.hidden = true; }}
          />
        )}
        <div className="mobile-memo-row__meta">
          {memo.tags.length > 0 && (
            <div className="mobile-memo-row__tags">
              {memo.tags.slice(0, 3).map((tag) => <span className="is-tag" key={tag}>#{tag}</span>)}
            </div>
          )}
          <div className="mobile-memo-row__details">
            <time className="mobile-memo-row__created-at">{relativeTime(memo.createdAt)}</time>
            {memo.favorited && <PushPinIcon className="mobile-memo-row__pinned-icon" size={14} weight="fill" aria-label="已置顶" />}
          </div>
        </div>
      </div>
      </button>
    </div>
  );
}

export function MobileMemoList({ items, loading, onRefresh, onOpen, openMemoId, onToggleActions, onDelete, onTogglePin, searchQuery = '', searching = false }: MobileMemoListProps) {
  const listRef = useRef<HTMLElement | null>(null);
  const pullGestureRef = useRef({ startX: 0, startY: 0, distance: 0, active: false, hapticTriggered: false });
  const [pullOffset, setPullOffset] = useState(0);

  const triggerPullHaptic = () => {
    if (navigator.vibrate) {
      navigator.vibrate(8);
      return;
    }
    void mobileClient.hapticLight().catch(() => undefined);
  };

  const resetPullGesture = () => {
    pullGestureRef.current = { startX: 0, startY: 0, distance: 0, active: false, hapticTriggered: false };
    setPullOffset(0);
  };

  const handleTouchStart = (event: React.TouchEvent<HTMLElement>) => {
    const touch = event.touches[0];
    const list = listRef.current;
    if (!touch || !list || list.scrollTop > 0) return;
    pullGestureRef.current = { startX: touch.clientX, startY: touch.clientY, distance: 0, active: true, hapticTriggered: false };
  };

  const handleTouchMove = (event: React.TouchEvent<HTMLElement>) => {
    const gesture = pullGestureRef.current;
    const touch = event.touches[0];
    const list = listRef.current;
    if (!gesture.active || !touch || !list) return;
    if (list.scrollTop > 0) {
      resetPullGesture();
      return;
    }
    const deltaY = touch.clientY - gesture.startY;
    const deltaX = touch.clientX - gesture.startX;
    if (Math.abs(deltaX) > Math.abs(deltaY) * 1.2 && Math.abs(deltaX) > SWIPE_ACTIVATION_DISTANCE) {
      resetPullGesture();
      return;
    }
    if (deltaY <= 0) {
      resetPullGesture();
      return;
    }
    const distance = Math.min(deltaY * 0.5, PULL_MAX_DISTANCE);
    gesture.distance = distance;
    setPullOffset(distance);
    if (distance >= PULL_REFRESH_THRESHOLD && !gesture.hapticTriggered) {
      gesture.hapticTriggered = true;
      triggerPullHaptic();
    }
  };

  const handleTouchEnd = () => {
    const { active, distance } = pullGestureRef.current;
    if (!active) return;
    resetPullGesture();
    if (distance >= PULL_REFRESH_THRESHOLD) void onRefresh();
  };

  return (
    <section
      ref={listRef}
      className={`mobile-memo-list${pullOffset > 0 ? ' is-pulling' : ''}`}
      aria-busy={loading || searching}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={resetPullGesture}
      style={{ transform: pullOffset > 0 ? `translateY(${pullOffset}px)` : undefined }}
    >
      {searching && (
        <div className="mobile-searching-overlay" aria-live="polite">
          <span className="mobile-searching-overlay__status"><LoaderCircle className="is-spinning" size={18} aria-hidden="true" />正在搜索…</span>
        </div>
      )}
      {loading && items.length === 0 ? (
        <div className="mobile-empty-state">正在加载…</div>
      ) : items.length === 0 ? (
        searchQuery ? (
          <div className="mobile-empty-state"><BookOpenText size={30} /><strong>没有找到匹配的笔记</strong><span>试试其他关键词</span></div>
        ) : (
          <div className="mobile-empty-state"><BookOpenText size={30} /><strong>这里还没有笔记</strong><span>点击右下角开始记录</span></div>
        )
      ) : items.map((memo) => <MobileMemoRow key={memo.id} memo={memo} onOpen={onOpen} actionsOpen={openMemoId === memo.id} onToggleActions={onToggleActions} onDelete={onDelete} onTogglePin={onTogglePin} />)}
    </section>
  );
}
