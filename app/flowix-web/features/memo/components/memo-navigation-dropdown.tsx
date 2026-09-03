'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Folder, Hash, Layers, ListTodo } from 'lucide-react';
import { StarFourIcon } from '@phosphor-icons/react';

import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { normalizeFilesDefaults } from '@/lib/agent-access-defaults';
import { useMemoStore, useTagStore } from '@features/memo';
import { useAgentAccessStore } from '@features/agent/store/agent-access-store';
import { TagMentionName } from '@features/editor/extensions/tag-mention/tag-mention-label';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { DROPDOWN_DIVIDER_SKIN } from '@shared/ui/dropdown-divider';

export type MemoNavigationTarget = 'all' | 'agents' | 'todos' | 'tags';

interface NavigationSubmenuProps {
  label: ReactNode;
  icon?: ReactNode;
  itemIcon?: ReactNode;
  itemKind?: 'tag' | 'reference';
  labelAdornment?: ReactNode;
  /**
   * 尾部 ChevronRight 旁的当前值提示（例如已选的筛选 / 排序）。
   * 与 labelAdornment 不同：labelAdornment 贴在 label 文本后（左侧），
   * valueAdornment 贴在右侧 Chevron 旁（尾部）。
   */
  valueAdornment?: ReactNode;
  open: boolean;
  active?: boolean;
  items?: Array<{ id: string; label: string; secondary?: string }>;
  loading?: boolean;
  emptyText: string;
  loadingText: string;
  /**
   * 隐藏二级弹窗顶部的 group label（默认渲染 label 文案）。
   * 自定义 submenuContent 时如果调用方已在内部写了分组标题，
   * 顶部那个与 label 同名的 header 就会冗余 ── 传 true 不渲染。
   */
  hideHeader?: boolean;
  submenuContent?: ReactNode;
  onOpenChange: (open: boolean) => void;
  onCloseMenu?: () => void;
  onSelect?: (id: string) => void;
  onClick?: () => void;
}

export function MemoNavigationSubmenu({
  label,
  icon,
  itemIcon,
  itemKind,
  labelAdornment,
  valueAdornment,
  open,
  active = false,
  items = [],
  loading = false,
  emptyText,
  loadingText,
  hideHeader = false,
  submenuContent,
  onOpenChange,
  onCloseMenu,
  onSelect,
  onClick,
}: NavigationSubmenuProps) {
  const closeTimerRef = useRef<number | null>(null);

  const cancelClose = () => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };

  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      onOpenChange(false);
      closeTimerRef.current = null;
    }, 160);
  };

  useEffect(() => () => cancelClose(), []);

  return (
    <div
      className="relative"
      onMouseEnter={() => {
        cancelClose();
        onOpenChange(true);
      }}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className={cn(
          'flex h-7 w-full cursor-pointer items-center justify-between rounded-lg py-0 pl-[6px] pr-2 text-sm text-[var(--foreground)] outline-none',
          active
            ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
            : open
              ? 'bg-[var(--muted)]'
              : 'hover:bg-[var(--muted)]',
        )}
        onClick={() => {
          onClick?.();
          if (onClick) {
            onCloseMenu?.();
            return;
          }
          onOpenChange(!open);
        }}
      >
        <span className={cn('flex min-w-0 items-center', icon && 'gap-2')}>
          {icon}
          <span className="truncate">{label}</span>
          {labelAdornment}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {valueAdornment}
          <ChevronRight className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
        </span>
      </button>
      {open && (
        <div className="absolute left-full top-0 z-[1501] flex max-h-[min(560px,calc(100vh-16px))] w-[220px] flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)] px-1 pb-1 pt-1.5 shadow-lg">
          {!hideHeader && (
            <div
              className="mention-note-header"
              aria-label={typeof label === 'string' ? label : undefined}
            >
              <span>{label}</span>
              {labelAdornment}
            </div>
          )}
          {submenuContent ?? (
            <OverlayScrollbar
              className="mention-note-items-frame"
              scrollerClassName="mention-note-items"
            >
              {loading ? (
                <div className="mention-note-empty mention-note-empty--loading">{loadingText}</div>
              ) : items.length === 0 ? (
                <div className="mention-note-empty">{emptyText}</div>
              ) : (
                items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    title={item.secondary ? `${item.label} · ${item.secondary}` : item.label}
                    className="mention-note-item !h-7 !min-h-7 !rounded-lg !py-0 !pl-[6px] !pr-2 hover:bg-[var(--muted)] focus-visible:bg-[var(--muted)] focus-visible:outline-none"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      onSelect?.(item.id);
                      onCloseMenu?.();
                      onOpenChange(false);
                    }}
                  >
                    {itemKind === 'tag' ? (
                      <span className="mention-note-title mention-tag-title">
                        <span className="mention-tag-icon" aria-hidden="true" />
                        <TagMentionName name={item.label} />
                      </span>
                    ) : (
                      <span className="flex min-w-0 items-center gap-2">
                        {itemIcon}
                        <span className="mention-note-title">{item.label}</span>
                      </span>
                    )}
                    {itemKind === 'reference' && item.secondary && (
                      <span className="mention-note-notebook mention-note-notebook-name">
                        {item.secondary}
                      </span>
                    )}
                  </button>
                ))
              )}
            </OverlayScrollbar>
          )}
        </div>
      )}
    </div>
  );
}

interface MemoNavigationDropdownProps {
  title: ReactNode;
  titleTooltip?: string;
  ariaLabel: string;
  children?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onNavigate?: (target: MemoNavigationTarget) => void;
  className?: string;
}

/**
 * Shared navigation menu for the three middle-column list views.
 *
 * The navigation entries intentionally live here instead of being copied into
 * MemoList, AgentConversationList, and FolderFileTree. Each caller can append
 * its own menu section after the shared navigation without losing the actions
 * that belong to that view.
 */
export function MemoNavigationDropdown({
  title,
  titleTooltip,
  ariaLabel,
  children,
  open,
  onOpenChange,
  onNavigate,
  className,
}: MemoNavigationDropdownProps) {
  const { t } = useI18n();
  const activeFilter = useMemoStore((state) => state.activeFilter);
  const activeFileBrowserPath = useMemoStore((state) => state.activeFileBrowserPath);
  const selectedNotebook = useMemoStore((state) => state.selectedNotebook);
  const setActiveFilter = useMemoStore((state) => state.setActiveFilter);
  const setActiveFileBrowserPath = useMemoStore((state) => state.setActiveFileBrowserPath);
  const setSelectedTagId = useTagStore((state) => state.setSelectedTagId);
  const tags = useTagStore((state) => state.tags);
  const loadTags = useTagStore((state) => state.loadTags);
  const accessConfig = useAgentAccessStore((state) => state.config);
  const [internalOpen, setInternalOpen] = useState(false);
  const [openSubmenu, setOpenSubmenu] = useState<'tags' | 'references' | null>(null);
  const selectedNotebookId = selectedNotebook?.id ?? null;
  const menuOpen = open ?? internalOpen;

  const handleMenuOpenChange = useCallback((nextOpen: boolean) => {
    if (open === undefined) {
      setInternalOpen(nextOpen);
    }
    onOpenChange?.(nextOpen);
  }, [onOpenChange, open]);

  const closeMenu = useCallback(() => {
    handleMenuOpenChange(false);
  }, [handleMenuOpenChange]);

  useEffect(() => {
    if (!selectedNotebookId) return;
    void loadTags(selectedNotebookId);
  }, [loadTags, selectedNotebookId]);

  const isActive = (target: MemoNavigationTarget): boolean => {
    if (activeFileBrowserPath !== null) return false;
    if (target === 'tags') return activeFilter === 'tagged';
    return activeFilter === target;
  };

  const handleNavigate = (target: MemoNavigationTarget) => {
    // Navigation to the category itself has no specific tag selected. The
    // tag tree remains available on the left for choosing an individual tag.
    setSelectedTagId(null);
    setActiveFilter(target === 'tags' ? 'tagged' : target);
    onNavigate?.(target);
  };

  const handleTagSelect = (tagId: string) => {
    setSelectedTagId(tagId);
    setActiveFilter('tagged');
  };

  const handleReferenceSelect = useCallback((folderPath: string) => {
    setActiveFileBrowserPath(folderPath);
  }, [setActiveFileBrowserPath]);

  const tagSubmenuItems = tags.map((tag) => ({ id: tag.id, label: tag.name }));
  const defaultFiles = selectedNotebookId
    ? normalizeFilesDefaults(accessConfig.defaults?.files)[selectedNotebookId]
    : undefined;
  const referenceSubmenuItems = (defaultFiles?.folders ?? []).map((path) => {
    const trimmed = path.replace(/[\\/]+$/, '');
    const entry = accessConfig.entries.find(
      (candidate) => candidate.kind === 'folder'
        && candidate.path.trim().replace(/[\\/]+$/, '').toLowerCase() === trimmed.toLowerCase(),
    );
    return { id: path, label: entry?.name ?? trimmed.split(/[\\/]/).pop() ?? trimmed };
  });

  return (
    <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          title={titleTooltip}
          className={cn(
            'group flex max-w-full min-w-0 items-center gap-0.5 overflow-hidden rounded-md py-0.5 pl-0 pr-2 transition-colors',
            className,
          )}
        >
          <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-[var(--foreground)] transition-colors duration-150 group-hover:text-[color-mix(in_oklch,var(--foreground)_80%,white)]">
            {title}
          </span>
          <ChevronDown
            aria-hidden="true"
            className="h-3.5 w-3 shrink-0 text-[var(--foreground)]"
            strokeWidth={2.5}
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" className="w-[220px] space-y-0.5 px-1 py-1.5">
        <DropdownMenuItem
          onClick={() => handleNavigate('all')}
          className={cn(
            'flex h-7 cursor-pointer items-center justify-between rounded-lg py-0 pl-[6px] pr-2',
            isActive('all')
              ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
              : 'hover:bg-[var(--muted)]',
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Layers className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{t('memo.navigation.allNotes')}</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => handleNavigate('agents')}
          className={cn(
            'flex h-7 cursor-pointer items-center justify-between rounded-lg py-0 pl-[6px] pr-2',
            isActive('agents')
              ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
              : 'hover:bg-[var(--muted)]',
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            <StarFourIcon className="h-4 w-4 shrink-0" weight="regular" aria-hidden="true" />
            <span>{t('memo.navigation.conversations')}</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => handleNavigate('todos')}
          className={cn(
            'flex h-7 cursor-pointer items-center justify-between rounded-lg py-0 pl-[6px] pr-2',
            isActive('todos')
              ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
              : 'hover:bg-[var(--muted)]',
          )}
        >
          <span className="flex min-w-0 items-center gap-2">
            <ListTodo className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{t('memo.list.filterTasks')}</span>
          </span>
        </DropdownMenuItem>
        <MemoNavigationSubmenu
          label={t('memo.navigation.tags')}
          icon={<Hash className="h-4 w-4 shrink-0" aria-hidden="true" />}
          itemIcon={<Hash className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />}
          itemKind="tag"
          open={openSubmenu === 'tags'}
          active={isActive('tags')}
          items={tagSubmenuItems}
          emptyText={t('memo.navigation.emptyTags')}
          loadingText={t('memo.navigation.loading')}
          onOpenChange={(open) => setOpenSubmenu((current) => {
            if (open) return 'tags';
            return current === 'tags' ? null : current;
          })}
          onCloseMenu={closeMenu}
          onSelect={handleTagSelect}
          onClick={() => handleNavigate('tags')}
        />
        <MemoNavigationSubmenu
          label={t('memo.navigation.referenceMaterials')}
          icon={<Folder className="h-4 w-4 shrink-0" aria-hidden="true" />}
          itemIcon={<Folder className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" aria-hidden="true" />}
          itemKind="reference"
          open={openSubmenu === 'references'}
          active={activeFileBrowserPath !== null}
          items={referenceSubmenuItems}
          emptyText={t('memo.navigation.emptyReferences')}
          loadingText={t('memo.navigation.loading')}
          onOpenChange={(open) => setOpenSubmenu((current) => {
            if (open) return 'references';
            return current === 'references' ? null : current;
          })}
          onCloseMenu={closeMenu}
          onSelect={handleReferenceSelect}
        />
        {children && (
          <>
            <hr className={cn('mx-2 my-1 border-0', DROPDOWN_DIVIDER_SKIN)} />
            <div>{children}</div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
