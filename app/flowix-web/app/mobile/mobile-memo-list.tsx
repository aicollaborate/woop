import { BookOpenText, CheckCircle2 } from 'lucide-react';

import type { MemoItem } from '@/types/memo-item';

interface MobileMemoListProps {
  items: MemoItem[];
  loading: boolean;
  onOpen: (id: string) => void;
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

export function MobileMemoList({ items, loading, onOpen }: MobileMemoListProps) {
  return (
    <section className="mobile-memo-list" aria-busy={loading}>
      {loading && items.length === 0 ? (
        <div className="mobile-empty-state">正在加载…</div>
      ) : items.length === 0 ? (
        <div className="mobile-empty-state"><BookOpenText size={30} /><strong>这里还没有笔记</strong><span>点击右下角开始记录</span></div>
      ) : items.map((memo) => (
        <button type="button" className="mobile-memo-row" key={memo.id} onClick={() => onOpen(memo.id)}>
          <div className="mobile-memo-row__title">
            <strong>{noteTitle(memo.filename)}</strong>
            <time>{relativeTime(memo.updatedAt)}</time>
          </div>
          {memo.preview && <p>{memo.preview}</p>}
          <div className="mobile-memo-row__meta">
            {memo.tags.slice(0, 3).map((tag) => <span className="is-tag" key={tag}>#{tag}</span>)}
            {memo.agents.length > 0 && <span className="is-agent">Agent {memo.agents.length}</span>}
            {memo.todos.length > 0 && <span className="is-todo"><CheckCircle2 size={10} />待办 {memo.todos.length}</span>}
          </div>
        </button>
      ))}
    </section>
  );
}
