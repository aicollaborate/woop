'use client';

import { StarFourIcon } from '@phosphor-icons/react';
import { Layers, ListTodo } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { cn } from '@/lib/utils';
import { useMemoStore } from '@features/memo';
import { useTagStore } from '@features/memo';
import { useI18n } from '@/lib/i18n';

interface NavFilterButtonsProps {
  totalMemoCount: number;
  agentMemoCount: number;
  todoMemoCount: number;
}

// 顶部过滤器 (全部 / 对话 / 待办) ── 从 NoteNavigationPanel 拆出。
// 三个按钮各自把 selectedTagId 清空并切 activeFilter; counts 由父级
// (经 TagTree 的 loadTags -> onCountsChange 上抛) 传入。
// activeFilter / setSelectedTagId / setActiveFilter 直接订阅 store,
// 不再经 props 透传。
export function NavFilterButtons({
  totalMemoCount,
  agentMemoCount,
  todoMemoCount,
}: NavFilterButtonsProps) {
  const { t } = useI18n();
  const activeFilter = useMemoStore((s) => s.activeFilter);
  const { setActiveFilter } = useMemoStore(
    useShallow((s) => ({
      setActiveFilter: s.setActiveFilter,
    })),
  );
  const setSelectedTagId = useTagStore((s) => s.setSelectedTagId);

  const handleShowAllTags = () => {
    setSelectedTagId(null);
    setActiveFilter('all');
  };

  const handleShowAgentMemos = () => {
    setSelectedTagId(null);
    setActiveFilter('agents');
  };

  const handleShowTaskMemos = () => {
    setSelectedTagId(null);
    setActiveFilter('todos');
  };

  return (
    // 过滤器 (全部/对话/待办) ── 占顶部, 与下方标签组以分隔线分开。
    <div className="space-y-0.5 pt-2">
      <div
        role="button"
        tabIndex={0}
        onClick={handleShowAllTags}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleShowAllTags();
          }
        }}
        className={cn(
          'group relative flex h-8 w-full cursor-pointer select-none items-center gap-0 rounded-md pr-2 text-left text-sm transition-colors',
          activeFilter === 'all'
            ? 'bg-[var(--muted)] text-[var(--foreground)]'
            : 'text-[var(--foreground)] hover:bg-[var(--muted)]',
        )}
        style={{ paddingLeft: 6 }}
        aria-pressed={activeFilter === 'all'}
      >
        <span className="mr-2 shrink-0 opacity-90">
          <Layers className="h-3.5 w-3.5 text-[var(--foreground)]" />
        </span>
        <span className="min-w-0 flex-1 truncate">{t("memo.list.filterAll")}</span>
        <span className="ml-2 shrink-0 tabular-nums text-xs text-[var(--muted-foreground)]">
          {totalMemoCount}
        </span>
      </div>
      <div
        role="button"
        tabIndex={0}
        onClick={handleShowAgentMemos}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleShowAgentMemos();
          }
        }}
        className={cn(
          'group relative flex h-8 w-full cursor-pointer select-none items-center gap-0 rounded-md pr-2 text-left text-sm transition-colors',
          activeFilter === 'agents'
            ? 'bg-[var(--muted)] text-[var(--foreground)]'
            : 'text-[var(--foreground)] hover:bg-[var(--muted)]',
        )}
        style={{ paddingLeft: 6 }}
        aria-pressed={activeFilter === 'agents'}
      >
        <span className="mr-2 shrink-0 opacity-90">
          <StarFourIcon
            className="h-3.5 w-3.5 text-[var(--foreground)]"
            weight="bold"
          />
        </span>
        <span className="min-w-0 flex-1 truncate">{t("memo.list.filterAgents")}</span>
        <span className="ml-2 shrink-0 tabular-nums text-xs text-[var(--muted-foreground)]">
          {agentMemoCount}
        </span>
      </div>
      <div
        role="button"
        tabIndex={0}
        onClick={handleShowTaskMemos}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleShowTaskMemos();
          }
        }}
        className={cn(
          'group relative flex h-8 w-full cursor-pointer select-none items-center gap-0 rounded-md pr-2 text-left text-sm transition-colors',
          activeFilter === 'todos'
            ? 'bg-[var(--muted)] text-[var(--foreground)]'
            : 'text-[var(--foreground)] hover:bg-[var(--muted)]',
        )}
        style={{ paddingLeft: 6 }}
        aria-pressed={activeFilter === 'todos'}
      >
        <span className="mr-2 shrink-0 opacity-90">
          <ListTodo className="h-3.5 w-3.5 text-[var(--foreground)]" />
        </span>
        <span className="min-w-0 flex-1 truncate">{t("memo.list.filterTasks")}</span>
        <span className="ml-2 shrink-0 tabular-nums text-xs text-[var(--muted-foreground)]">
          {todoMemoCount}
        </span>
      </div>
    </div>
  );
}
