'use client';

import { SidebarToggleIcon } from '@shared/icons/sidebar-toggle-icon';
import { Tooltip } from '@shared/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { NotebookIconMenu } from './notebook-icon-menu';
import type { Notebook } from '../store';

interface MemoListTitlebarWinProps {
  noteNavigationVisible: boolean;
  selectedNotebook: Notebook | null;
  onCollapseMemoList: () => void;
  onToggleNoteNavigation: () => void;
  onOpenPreferences: (tab?: string) => void;
}

export function MemoListTitlebarWin({
  noteNavigationVisible,
  selectedNotebook,
  onCollapseMemoList,
  onToggleNoteNavigation,
  onOpenPreferences,
}: MemoListTitlebarWinProps) {
  const { t } = useI18n();

  return (
    <div
      data-tauri-drag-region
      className="relative h-9 px-2 shrink-0 flex items-center justify-between gap-1"
    >
      <div className="ml-1 flex items-center">
        {!noteNavigationVisible && selectedNotebook && (
          <NotebookIconMenu
            noteNavigationVisible={noteNavigationVisible}
            onToggleNoteNavigation={onToggleNoteNavigation}
            onOpenPreferences={onOpenPreferences}
            buttonClassName="h-6 w-6"
          />
        )}
      </div>
      <div className="flex items-center gap-1">
        <Tooltip content={t("memo.list.collapseMemoListTooltip")} shortcut="panel.memoList.toggle">
          <button
            type="button"
            onClick={onCollapseMemoList}
            aria-label={t("memo.list.collapseMemoList")}
            className="w-7 h-7 flex items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
          >
            <SidebarToggleIcon className="w-4 h-4" />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
