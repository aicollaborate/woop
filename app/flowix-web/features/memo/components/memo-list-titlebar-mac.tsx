'use client';

import { SidebarToggleIcon } from '@shared/icons/sidebar-toggle-icon';
import { Tooltip } from '@shared/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { NotebookIconMenu } from './notebook-icon-menu';
import type { Notebook } from '../store';

interface MemoListTitlebarMacProps {
  noteNavigationVisible: boolean;
  selectedNotebook: Notebook | null;
  onCollapseSidebar: () => void;
  onToggleNoteNavigation: () => void;
  onOpenPreferences: () => void;
}

export function MemoListTitlebarMac({
  noteNavigationVisible,
  selectedNotebook,
  onCollapseSidebar,
  onToggleNoteNavigation,
  onOpenPreferences,
}: MemoListTitlebarMacProps) {
  const { t } = useI18n();
  return (
    <div
      data-tauri-drag-region
      className="h-12 px-1 shrink-0 flex items-center justify-between gap-1"
    >
      <div className={`${noteNavigationVisible ? 'ml-0' : 'ml-[82px]'} flex items-center`}>
        {selectedNotebook && (
          <NotebookIconMenu
            onToggleNoteNavigation={onToggleNoteNavigation}
            onOpenPreferences={onOpenPreferences}
            buttonClassName="ml-1"
          />
        )}
      </div>
      <Tooltip content={t("memo.list.collapseSidebarTooltip")} shortcut="panel.memoList.toggle">
        <button
          type="button"
          onClick={onCollapseSidebar}
          aria-label={t("memo.list.collapseSidebar")}
          className="w-8 h-8 mr-0.5 flex items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
        >
          <SidebarToggleIcon className="w-5 h-5" />
        </button>
      </Tooltip>
    </div>
  );
}
