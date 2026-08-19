'use client';

import { SidebarToggleIcon } from '@shared/icons/sidebar-toggle-icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import { Tooltip } from '@shared/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { ChevronDown } from 'lucide-react';
import { NotebookIcon, getNotebookIconOption } from './notebook-icon';
import productLogo from '@/assets/productlogo.png';
import { cn } from '@/lib/utils';
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
          <button
            type="button"
            onClick={onToggleNoteNavigation}
            aria-label={t("memo.list.notebookNavToggle")}
            title={selectedNotebook.name}
            className="group ml-1 flex shrink-0 items-center cursor-pointer"
          >
            {getNotebookIconOption(selectedNotebook.icon) ? (
              <NotebookIcon
                icon={selectedNotebook.icon}
                name={selectedNotebook.name}
                className={cn(
                  'h-6 w-6 text-[11px] font-semibold text-[var(--secondary-foreground)] transition-colors group-hover:text-[var(--foreground)]',
                  selectedNotebook.missing && 'opacity-70',
                )}
              />
            ) : (
              <img
                src={productLogo}
                alt=""
                aria-hidden="true"
                className="h-[18px] w-[18px] shrink-0 rounded opacity-75 transition-opacity group-hover:opacity-100"
              />
            )}
          </button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Flowix menu"
              className="group w-4 h-8 flex items-center justify-center rounded-md select-none transition-colors data-[state=open]:bg-[var(--muted)]"
            >
              <ChevronDown
                className="w-3 h-3 text-[var(--muted-foreground)] shrink-0 transition-colors group-hover:text-[var(--foreground)]"
                strokeWidth={2.5}
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            side="bottom"
            sideOffset={2}
            className="w-[12.8rem] p-1 bg-[var(--popover)]"
          >
            <DropdownMenuItem
              onClick={onToggleNoteNavigation}
              className="rounded-md px-2 py-1.5 hover:bg-[var(--muted)]"
            >
              {t('shell.statusBar.noteNav')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={onOpenPreferences}
              className="rounded-md px-2 py-1.5 hover:bg-[var(--muted)]"
            >
              {t('status.preferences')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
