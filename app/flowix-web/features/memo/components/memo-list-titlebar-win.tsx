'use client';

import { SidebarToggleIcon } from '@shared/icons/sidebar-toggle-icon';
import { Tooltip } from '@shared/ui/tooltip';
import { NotebookIconMenu } from './notebook-icon-menu';
import type { Notebook } from '../store';

interface MemoListTitlebarWinProps {
  selectedNotebook: Notebook | null;
  onCollapseSidebar: () => void;
  onToggleNoteNavigation: () => void;
  onOpenPreferences: () => void;
}

export function MemoListTitlebarWin({
  selectedNotebook,
  onCollapseSidebar,
  onToggleNoteNavigation,
  onOpenPreferences,
}: MemoListTitlebarWinProps) {
  return (
    <div
      data-tauri-drag-region
      className="h-9 px-2 shrink-0 flex items-center justify-between gap-1"
    >
      <div className="ml-1 flex items-center">
        {selectedNotebook && (
          <NotebookIconMenu
            onToggleNoteNavigation={onToggleNoteNavigation}
            onOpenPreferences={onOpenPreferences}
          />
        )}
      </div>
      <div className="flex items-center gap-1">
        <Tooltip content="Collapse sidebar" shortcut="panel.memoList.toggle">
          <button
            type="button"
            onClick={onCollapseSidebar}
            aria-label="Collapse sidebar"
            className="w-7 h-7 flex items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition-colors"
          >
            <SidebarToggleIcon className="w-4 h-4" />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
