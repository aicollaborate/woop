'use client';

import { StarFourIcon } from '@phosphor-icons/react';
import { Layers, ListTodo } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useMemoStore } from '@features/memo';
import { useI18n } from '@/lib/i18n';

interface NavFilterButtonsProps {
  totalMemoCount: number;
  agentMemoCount: number;
  todoMemoCount: number;
  onSelectFilter?: () => void;
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
  onSelectFilter,
}: NavFilterButtonsProps) {
  const { t } = useI18n();
  const activeFilter = useMemoStore((s) => s.activeFilter);
  const activeFileBrowserPath = useMemoStore((s) => s.activeFileBrowserPath);
  const setActiveFilter = useMemoStore((s) => s.setActiveFilter);
  // 文件夹浏览是和全部 / 对话 / 待办 / 标签并列的一个入口。浏览资料时
  // activeFilter 为 all 只是中间列的数据兜底，不能让“全部”也显示选中。
  const isFilterActive = (filter: typeof activeFilter) =>
    activeFileBrowserPath === null && activeFilter === filter;

  // 三个按钮都委托 setActiveFilter: 它在内部把 activePluginId /
  // activeFileBrowserPath / selectedTagId 全部归位, 互斥单选语义集中
  // 在一处。无需在这里手动 setSelectedTagId(null)。
  const handleShowAllTags = () => {
    onSelectFilter?.();
    setActiveFilter('all');
  };

  const handleShowAgentMemos = () => {
    onSelectFilter?.();
    setActiveFilter('agents');
  };

  const handleShowTaskMemos = () => {
    onSelectFilter?.();
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
          isFilterActive('all')
            ? 'bg-[var(--muted)] text-[var(--foreground)]'
            : 'text-[var(--foreground)] hover:bg-[var(--muted)]',
        )}
        style={{ paddingLeft: 6 }}
        aria-pressed={isFilterActive('all')}
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
          isFilterActive('agents')
            ? 'bg-[var(--muted)] text-[var(--foreground)]'
            : 'text-[var(--foreground)] hover:bg-[var(--muted)]',
        )}
        style={{ paddingLeft: 6 }}
        aria-pressed={isFilterActive('agents')}
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
          isFilterActive('todos')
            ? 'bg-[var(--muted)] text-[var(--foreground)]'
            : 'text-[var(--foreground)] hover:bg-[var(--muted)]',
        )}
        style={{ paddingLeft: 6 }}
        aria-pressed={isFilterActive('todos')}
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
