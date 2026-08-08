import { BookOpenText } from 'lucide-react';
import { PushPinIcon, TrashSimpleIcon } from '@phosphor-icons/react';
import { useRef } from 'react';

import { assetUrl, decodeStorageKey } from '@features/editor/extensions/attachment-link/utils';
import type { MemoItem } from '@/types/memo-item';

interface MobileMemoListProps {
  items: MemoItem[];
  loading: boolean;
  onOpen: (id: string) => void;
  openMemoId: string | null;
  onToggleActions: (id: string) => void;
  onDelete: (id: string) => void;
  onTogglePin: (memo: MemoItem) => void;
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
  const gestureRef = useRef({ startX: 0, startY: 0, swiping: false });

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    gestureRef.current = { startX: event.clientX, startY: event.clientY, swiping: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    const horizontal = Math.abs(dx) > Math.abs(dy) * 1.2;
    if (horizontal && (dx < -12 || dx > 12)) gesture.swiping = true;
  };
  const handlePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current;
    const dx = event.clientX - gesture.startX;
    if (gesture.swiping && (dx < -48 || (actionsOpen && dx > 48))) {
      onToggleActions(memo.id);
    }
  };

  return (
    <div className={`mobile-memo-row-shell${actionsOpen ? ' is-actions-open' : ''}`}>
      <div className="mobile-memo-row-actions" aria-label="笔记操作">
        <button
          type="button"
          className="mobile-memo-row-action mobile-memo-row-action--pin"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); onTogglePin(memo); }}
        >
          <PushPinIcon size={18} weight={memo.favorited ? 'fill' : 'regular'} />
          <span>{memo.favorited ? '取消置顶' : '置顶'}</span>
        </button>
        <button
          type="button"
          className="mobile-memo-row-action mobile-memo-row-action--delete"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); onDelete(memo.id); }}
        >
          <TrashSimpleIcon size={18} weight="regular" />
          <span>删除</span>
        </button>
      </div>
      <button
        type="button"
        className="mobile-memo-row"
        aria-expanded={actionsOpen}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => { gestureRef.current.swiping = false; }}
        onClick={(event) => {
          if (gestureRef.current.swiping) {
            gestureRef.current.swiping = false;
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
        <div className="mobile-memo-row__meta">
          <time className="mobile-memo-row__created-at">{relativeTime(memo.createdAt)}</time>
          {memo.favorited && <PushPinIcon className="mobile-memo-row__pinned-icon" size={14} weight="fill" aria-label="已置顶" />}
          {memo.tags.slice(0, 3).map((tag) => <span className="is-tag" key={tag}>#{tag}</span>)}
          {memo.agents.length > 0 && <span className="is-agent">Agent {memo.agents.length}</span>}
        </div>
      </div>
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
      </button>
    </div>
  );
}

export function MobileMemoList({ items, loading, onOpen, openMemoId, onToggleActions, onDelete, onTogglePin }: MobileMemoListProps) {
  return (
    <section className="mobile-memo-list" aria-busy={loading}>
      {loading && items.length === 0 ? (
        <div className="mobile-empty-state">正在加载…</div>
      ) : items.length === 0 ? (
        <div className="mobile-empty-state"><BookOpenText size={30} /><strong>这里还没有笔记</strong><span>点击右下角开始记录</span></div>
      ) : items.map((memo) => <MobileMemoRow key={memo.id} memo={memo} onOpen={onOpen} actionsOpen={openMemoId === memo.id} onToggleActions={onToggleActions} onDelete={onDelete} onTogglePin={onTogglePin} />)}
    </section>
  );
}
