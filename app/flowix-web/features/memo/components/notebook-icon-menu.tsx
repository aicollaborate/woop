'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { Palette, Plug, Type } from 'lucide-react';
import { StarFourIcon } from '@phosphor-icons/react';
import { AgentIcon } from '@features/agent/components/agent-icon';
import productLogo from '@/assets/productlogo.png';
import { cn } from '@/lib/utils';

interface NotebookIconMenuProps {
  onToggleNoteNavigation: () => void;
  /** 打开偏好设置窗口; 可传入偏好 tab id (如 'theme' / 'dsh' / 'mcp' / 'aiAgent')。 */
  onOpenPreferences: (tab?: string) => void;
  buttonClassName?: string;
}

// hover 打开下拉窗的延迟: 指针悬停多久后展示菜单。
const HOVER_OPEN_DELAY_MS = 800;
// hover 打开下拉窗的关闭延迟: 给指针留出从图标(trigger)跨越到 portal 菜单的间隙。
const HOVER_CLOSE_DELAY_MS = 150;

// 偏好设置分组下的分区直达项, 图标与偏好设置窗口侧栏保持一致。
const PREFERENCE_SHORTCUTS: {
  tab: string;
  labelKey: I18nKey;
  icon: React.ReactNode;
}[] = [
  {
    tab: 'format',
    labelKey: 'memo.list.notebookMenu.editorFormat',
    icon: <Type className="h-4 w-4 shrink-0" />,
  },
  {
    tab: 'theme',
    labelKey: 'memo.list.notebookMenu.appearanceTheme',
    icon: <Palette className="h-4 w-4 shrink-0" />,
  },
  {
    tab: 'dsh',
    labelKey: 'preferences.tabs.dsh',
    icon: <AgentIcon typeKey="deepseek-harness" alt="" className="h-4 w-4 shrink-0 object-contain" />,
  },
  {
    tab: 'mcp',
    labelKey: 'preferences.tabs.mcp',
    icon: <Plug className="h-4 w-4 shrink-0" />,
  },
  {
    tab: 'aiAgent',
    labelKey: 'memo.list.notebookMenu.otherAgents',
    icon: <StarFourIcon className="h-4 w-4 shrink-0" weight="regular" />,
  },
];

/**
 * 中间列顶部的图标 (统一展示产品图标):
 * - hover 图标 → 延迟展示 Flowix 下拉菜单 (笔记导航 / 偏好设置)
 * - 点击图标 → 切换笔记导航侧边栏 (原有逻辑不变, 不开关下拉窗)
 */
export function NotebookIconMenu({
  onToggleNoteNavigation,
  onOpenPreferences,
  buttonClassName,
}: NotebookIconMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const cancelOpen = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  // 悬停后延迟展示菜单; 离开图标或点击图标都会取消未触发的打开。
  const scheduleOpen = useCallback(() => {
    cancelOpen();
    cancelClose();
    openTimerRef.current = window.setTimeout(() => setOpen(true), HOVER_OPEN_DELAY_MS);
  }, [cancelOpen, cancelClose]);

  // 离开图标/菜单后延迟收起, 给指针留出跨越间隙的时间; 同时取消未触发的打开。
  const scheduleClose = useCallback(() => {
    cancelOpen();
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY_MS);
  }, [cancelOpen, cancelClose]);

  // 点击图标仅切换侧边栏, 并取消 hover 打开的排队。
  const handleIconClick = useCallback(() => {
    cancelOpen();
    onToggleNoteNavigation();
  }, [cancelOpen, onToggleNoteNavigation]);

  useEffect(() => {
    return () => {
      if (openTimerRef.current !== null) window.clearTimeout(openTimerRef.current);
      if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        // 下拉窗只由 hover 打开; 点击图标仅切换侧边栏。
        // 这里只接受"关闭"请求(点击外部 / Escape / 点击菜单项 / 点击图标时收起 hover 预览)。
        if (!next) setOpen(false);
      }}
    >
      <DropdownMenuTrigger asChild onClick={handleIconClick}>
        <button
          type="button"
          aria-label={t('memo.list.notebookNavToggle')}
          className={cn('group flex shrink-0 items-center cursor-pointer', buttonClassName)}
          onMouseEnter={scheduleOpen}
          onMouseLeave={scheduleClose}
        >
          <img
            src={productLogo}
            alt=""
            aria-hidden="true"
            className="h-[18px] w-[18px] shrink-0 rounded opacity-75 transition-opacity group-hover:opacity-100"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={2}
        className="w-[12.8rem] px-1 py-1.5 space-y-1 bg-[var(--popover)]"
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
      >
        <DropdownMenuItem
          onClick={() => window.dispatchEvent(new CustomEvent('flowix:create-memo'))}
          className="rounded-md px-2 py-1.5 hover:bg-[var(--muted)]"
        >
          {t('shell.commandPalette.action.newMemo')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => window.dispatchEvent(new CustomEvent('flowix:open-create-notebook'))}
          className="rounded-md px-2 py-1.5 hover:bg-[var(--muted)]"
        >
          {t('shell.commandPalette.action.newNotebook')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={onToggleNoteNavigation}
          className="rounded-md px-2 py-1.5 hover:bg-[var(--muted)]"
        >
          {t('shell.statusBar.noteNav')}
        </DropdownMenuItem>
        {/* 与筛选/排序等其它下拉窗一致的分割线样式 */}
        <hr className="mx-2 border-t border-[var(--border)] opacity-50" />
        <DropdownMenuLabel className="py-1.5 shrink-0 px-2 pt-1.5 pb-1 text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
          {t('memo.list.notebookMenu.preferences')}
        </DropdownMenuLabel>
        {PREFERENCE_SHORTCUTS.map(({ tab, labelKey, icon }) => (
          <DropdownMenuItem
            key={tab}
            onClick={() => onOpenPreferences(tab)}
            className="gap-1.5 rounded-md px-2 py-1.5 hover:bg-[var(--muted)]"
          >
            {icon}
            <span>{t(labelKey)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
