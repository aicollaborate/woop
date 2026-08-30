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
import { ArrowLeftToLine, ArrowRightToLine, Palette, Plug, Type } from 'lucide-react';
import { StarFourIcon } from '@phosphor-icons/react';
import { AgentIcon } from '@features/agent/components/agent-icon';
import { ShortcutKbd } from '@shared/ui/shortcut-kbd';
import { DROPDOWN_DIVIDER_SKIN } from '@shared/ui/dropdown-divider';
import productLogo from '@/assets/productlogo.png';
import { cn } from '@/lib/utils';

interface NotebookIconMenuProps {
  noteNavigationVisible: boolean;
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
 * - 点击整个产品图标按钮 → 展示下拉菜单
 */
export function NotebookIconMenu({
  noteNavigationVisible,
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
        setOpen(next);
      }}
    >
      <DropdownMenuTrigger asChild onClick={() => setOpen(true)}>
        <button
          type="button"
          aria-label={t('memo.list.notebookMenu.open')}
          title={t('memo.list.notebookMenu.open')}
          className={cn('group relative flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center', buttonClassName)}
          onMouseEnter={scheduleOpen}
          onMouseLeave={scheduleClose}
        >
          <img
            src={productLogo}
            alt=""
            aria-hidden="true"
            className="product-icon h-[18px] w-[18px] shrink-0 rounded opacity-75 transition-opacity group-hover:opacity-100"
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute bottom-[3px] right-[3px] h-0 w-0 border-b-[5px] border-l-[5px] border-l-transparent"
            style={{
              borderBottomColor: open
                ? 'var(--foreground)'
                : 'color-mix(in oklch, var(--foreground) 30%, var(--bg-titlebar))',
            }}
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
          onClick={onToggleNoteNavigation}
          className="gap-1.5 rounded-md px-2 py-1.5 hover:bg-[var(--muted)]"
        >
          {noteNavigationVisible ? (
            <ArrowLeftToLine className="h-4 w-4 shrink-0" />
          ) : (
            <ArrowRightToLine className="h-4 w-4 shrink-0" />
          )}
          <span>
            {t(
              noteNavigationVisible
                ? 'memo.list.notebookMenu.collapseNavigation'
                : 'memo.list.notebookMenu.expandNavigation',
            )}
          </span>
          <ShortcutKbd
            actionId="panel.noteNavigation.toggle"
            className="ml-auto text-[var(--muted-foreground)]"
          />
        </DropdownMenuItem>
        {/* 与筛选/排序等其它下拉窗一致的分割线样式 */}
        <hr className={cn('mx-2', DROPDOWN_DIVIDER_SKIN)} />
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
