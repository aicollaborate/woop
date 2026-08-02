'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, Cloud, LoaderCircle, Pencil, Plus } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { NotebookIcon, useMemoStore, type Notebook } from '@features/memo';
import { useI18n } from '@/lib/i18n';
import {
  cloud,
  listenToCloudStateChanges,
  listenToCloudSyncStatusChanges,
  type CloudSyncStatus,
} from '@platform/tauri/client';
import { useExperimentalMode } from '@platform/tauri/use-experimental-mode';
import { cloudSyncErrorMessage } from '@platform/tauri/errors';
import { useDragReorder, type DragDropTarget } from '@features/memo/hooks/use-drag-reorder';
import {
  computeNotebookDropPosition,
  reorderNotebookIds,
  type NotebookDropPosition,
} from '@features/memo/components/notebook-reorder';

interface NotebookListProps {
  notebooks: Notebook[];
  selectedNotebook: Notebook | null;
  onSelectNotebook: (notebook: Notebook) => void;
  onEditNotebook: (notebook: Notebook) => void;
}

// 笔记本列表折叠 ── 全局偏好 (不分 notebook), 默认展开。值用 '1'/'0'。
const NOTEBOOK_LIST_COLLAPSED_STORAGE_KEY = 'flowix:notebook-list-collapsed';

function readPersistedNotebookListCollapsed(): boolean {
  try {
    return localStorage.getItem(NOTEBOOK_LIST_COLLAPSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writePersistedNotebookListCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(NOTEBOOK_LIST_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    // 折叠状态是纯 UI 偏好, localStorage 不可用时不影响列表本身。
  }
}

// 笔记本列表区 ── 从 NoteNavigationPanel 拆出。自持:
//   - 拖拽重排 (useDragReorder, 替代原内联的 notebook 状态机)
//   - 折叠/展开动画 + 持久化
//   - 行点击选中 / 失效路径 toast / 行内编辑入口 / 「新建笔记本」按钮
// 与 tag 那套拖拽完全对称 (经 useDragReorder 收敛), 行为不变。
export function NotebookList({
  notebooks,
  selectedNotebook,
  onSelectNotebook,
  onEditNotebook,
}: NotebookListProps) {
  const { t } = useI18n();
  const experimental = useExperimentalMode();
  const reorderNotebooks = useMemoStore((s) => s.reorderNotebooks);

  // 折叠态: 折叠后仅展示选中的笔记本, 隐藏其余与「新建」按钮。
  // 初值取持久化: 上次关闭时的折叠态, 默认展开 (无记录 = false)。
  const [notebookListCollapsed, setNotebookListCollapsed] = useState(
    readPersistedNotebookListCollapsed,
  );
  // 折叠动画结束后才过滤非选中行 ── 立即过滤会让内容瞬间缩到 1 行, max-h
  // 收起动画因无内容可收而失效 (展开不过滤, 故展开动画正常)。 折叠时先把
  // 选中行滚到顶部, 保证收起后选中行可见。 折叠态直接 filter (无需动画):
  // 初始化即折叠时只渲染选中行, 避免选中行不在顶部而被 max-h 裁掉。
  // 展开态保持 false, 与原行为一致。
  const [notebookFilterActive, setNotebookFilterActive] = useState(
    readPersistedNotebookListCollapsed,
  );
  const [cloudSyncedNotebookIds, setCloudSyncedNotebookIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [cloudSyncStatuses, setCloudSyncStatuses] = useState<Map<string, CloudSyncStatus>>(
    () => new Map(),
  );
  const notebookScrollerRef = useRef<HTMLDivElement | null>(null);
  const collapseTimerRef = useRef<number | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const refreshCloudSyncedNotebookIds = useCallback(() => {
    if (!experimental) {
      setCloudSyncedNotebookIds(new Set());
      return;
    }
    void cloud.listNotebookStates()
      .then((links) => {
        setCloudSyncedNotebookIds(
          new Set(links.filter((link) => link.enabled).map((link) => link.notebookId)),
        );
      })
      .catch(() => {
        setCloudSyncedNotebookIds(new Set());
      });
  }, [experimental]);

  useEffect(() => {
    refreshCloudSyncedNotebookIds();
  }, [notebooks, refreshCloudSyncedNotebookIds]);

  useEffect(() => {
    if (!experimental) return;
    return listenToCloudStateChanges(refreshCloudSyncedNotebookIds);
  }, [experimental, refreshCloudSyncedNotebookIds]);

  useEffect(() => {
    if (!experimental) return;
    return listenToCloudSyncStatusChanges((status) => {
      setCloudSyncStatuses((previous) => {
        const current = previous.get(status.notebookId);
        if (current && status.startedAt < current.startedAt) {
          return previous;
        }
        const next = new Map(previous);
        next.set(status.notebookId, status);
        return next;
      });
    });
  }, [experimental]);

  useEffect(() => {
    if (!experimental || cloudSyncedNotebookIds.size === 0) return;
    const syncAfterConnectivityReturns = () => {
      void cloud.syncNow().catch(() => {
        // The native sync status event owns user-visible error reporting.
      });
    };
    const syncAfterForeground = () => {
      if (document.visibilityState === 'visible') syncAfterConnectivityReturns();
    };
    window.addEventListener('online', syncAfterConnectivityReturns);
    document.addEventListener('visibilitychange', syncAfterForeground);
    return () => {
      window.removeEventListener('online', syncAfterConnectivityReturns);
      document.removeEventListener('visibilitychange', syncAfterForeground);
    };
  }, [cloudSyncedNotebookIds, experimental]);

  // 笔记本行点击: 与 NotebookSwitcher 保持一致 ── 失效路径直接 toast 警告,
  // 不切换。有效路径走 onSelectNotebook 回调。
  const handleNotebookRowActivate = useCallback(
    (notebook: Notebook) => {
      if (notebook.missing) {
        toast.warning(t('status.invalidNotebookPath'));
        return;
      }
      onSelectNotebook(notebook);
    },
    [onSelectNotebook, t],
  );

  const handleCreateNotebookClick = useCallback(() => {
    window.dispatchEvent(new CustomEvent('flowix:open-create-notebook'));
  }, []);

  // 折叠/展开笔记本列表 ── 折叠时先选中行滚到 scroller 顶部 (保证收起后
  // 可见), 再触发 max-h 收起动画; 动画结束后 (duration-100) 才过滤非选中行。
  // 立即过滤会让内容瞬间缩到 1 行 (< max-h), max-h 无内容可收, 动画不执行。
  // 展开时先恢复全部行, 再展开 max-h (动画)。
  const toggleNotebookListCollapse = useCallback(() => {
    if (!notebookListCollapsed) {
      const scroller = notebookScrollerRef.current;
      const selectedId = useMemoStore.getState().selectedNotebook?.id;
      const selectedRow = selectedId
        ? rowRefs.current.get(selectedId)
        : null;
      if (scroller && selectedRow) {
        scroller.scrollTop +=
          selectedRow.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top;
      }
      setNotebookListCollapsed(true);
      writePersistedNotebookListCollapsed(true);
      if (collapseTimerRef.current !== null) window.clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = window.setTimeout(() => {
        setNotebookFilterActive(true);
        collapseTimerRef.current = null;
      }, 100);
    } else {
      if (collapseTimerRef.current !== null) {
        window.clearTimeout(collapseTimerRef.current);
        collapseTimerRef.current = null;
      }
      setNotebookFilterActive(false);
      setNotebookListCollapsed(false);
      writePersistedNotebookListCollapsed(false);
    }
  }, [notebookListCollapsed]);

  const findNotebookDropTarget = useCallback(
    (y: number, sourceId: string): DragDropTarget<NotebookDropPosition> | null => {
      const sourceIndex = notebooks.findIndex((nb) => nb.id === sourceId);
      if (sourceIndex < 0) return null;
      for (let index = 0; index < notebooks.length; index += 1) {
        if (index === sourceIndex) continue;
        const row = rowRefs.current.get(notebooks[index].id);
        if (!row) continue;
        const rect = row.getBoundingClientRect();
        if (y >= rect.top && y <= rect.bottom) {
          const position = computeNotebookDropPosition(y, rect.top, rect.height);
          return { id: notebooks[index].id, position };
        }
      }
      return null;
    },
    [notebooks],
  );

  const applyNotebookMove = useCallback(
    (sourceId: string, targetId: string, position: NotebookDropPosition) => {
      const ids = notebooks.map((nb) => nb.id);
      const nextIds = reorderNotebookIds(ids, sourceId, targetId, position);
      // source===target 或 source/target 不在列表 ── reorderNotebookIds 原样
      // 返回同一引用, 据此跳过持久化 (避免无意义 IPC)。
      if (nextIds === ids) return;
      void reorderNotebooks(nextIds);
    },
    [notebooks, reorderNotebooks],
  );

  // 无位移 -> 视为点击选中 (对齐 tag 行: pointerup 非拖动时选中,
  // 行上不再挂 onClick, 避免拖动刚过阈值松手时 click 误触发切换)。
  const handleNotebookSelect = useCallback(
    (sourceId: string) => {
      const nb = notebooks.find((n) => n.id === sourceId);
      if (nb) handleNotebookRowActivate(nb);
    },
    [handleNotebookRowActivate, notebooks],
  );

  const { draggingId, dropTarget, dragGhost, handlePointerDown } = useDragReorder<NotebookDropPosition>({
    findDropTarget: findNotebookDropTarget,
    applyMove: applyNotebookMove,
    onSelect: handleNotebookSelect,
  });

  const draggingNotebookId = draggingId;
  const notebookDropTarget = dropTarget;
  const notebookDragGhost = dragGhost;

  return (
    <div className="flex min-h-0 max-h-[320px] shrink-0 flex-col">
      <OverlayScrollbar
        className={cn(
          "min-h-0 flex-1 overflow-hidden transition-[max-height] duration-100",
          notebookListCollapsed ? "max-h-[44px]" : "max-h-[320px]",
        )}
        scrollerClassName="h-full overflow-y-auto px-2"
        scrollerRef={notebookScrollerRef}
      >
        <div className="space-y-0.5 pb-1">
          {notebooks.length === 0 ? (
            <div className="px-2 py-2 text-sm text-[var(--muted-foreground)]">
              {t('status.noNotebooks')}
            </div>
          ) : (
            notebooks.map((notebook) => {
              if (notebookFilterActive && notebook.id !== selectedNotebook?.id) return null;
              const isActive = selectedNotebook?.id === notebook.id;
              const isCloudSynced = cloudSyncedNotebookIds.has(notebook.id);
              const isMissing = Boolean(notebook.missing);
              const isNotebookDragging = draggingNotebookId === notebook.id;
              const showNotebookHoverBefore =
                notebookDropTarget?.id === notebook.id &&
                notebookDropTarget.position === 'before' &&
                !isNotebookDragging;
              const showNotebookHoverAfter =
                notebookDropTarget?.id === notebook.id &&
                notebookDropTarget.position === 'after' &&
                !isNotebookDragging;
              const cloudSyncStatus = cloudSyncStatuses.get(notebook.id);
              const cloudSyncInProgress =
                cloudSyncStatus?.state === 'queued' ||
                cloudSyncStatus?.state === 'checking' ||
                cloudSyncStatus?.state === 'syncing' ||
                cloudSyncStatus?.state === 'finalizing';
              return (
                <div
                  key={notebook.id}
                  role="button"
                  tabIndex={0}
                  onPointerDown={(event) =>
                    handlePointerDown(event, notebook.id)
                  }
                  ref={(el) => {
                    if (el) rowRefs.current.set(notebook.id, el);
                    else rowRefs.current.delete(notebook.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      handleNotebookRowActivate(notebook);
                    }
                  }}
                  className={cn(
                    'group relative flex h-8 w-full select-none items-center gap-2 rounded-md pl-1.5 pr-2 text-left text-sm transition-colors',
                    isCloudSynced && isActive
                      ? 'pr-14'
                      : (isCloudSynced || isActive) && 'pr-8',
                    isNotebookDragging
                      ? 'cursor-grabbing opacity-40'
                      : notebookListCollapsed
                        ? 'cursor-default'
                        : 'cursor-pointer',
                    !isNotebookDragging && 'text-[var(--foreground)]',
                    isMissing && 'opacity-70',
                  )}
                  style={{ touchAction: 'none' }}
                  title={notebook.name}
                  aria-pressed={isActive}
                  aria-grabbed={isNotebookDragging}
                >
                  {showNotebookHoverBefore && (
                    <div className="pointer-events-none absolute left-1 right-1 -top-px h-0.5 rounded bg-[var(--primary)] z-10" />
                  )}
                  {showNotebookHoverAfter && (
                    <div className="pointer-events-none absolute left-1 right-1 -bottom-px h-0.5 rounded bg-[var(--primary)] z-10" />
                  )}
                  <NotebookIcon
                    icon={notebook.icon}
                    name={notebook.name}
                    className="h-6 w-6 rounded-md bg-[var(--muted)] text-[11px] font-semibold text-[var(--secondary-foreground)]"
                    imageClassName="h-[72%] w-[72%]"
                  />
                  <div className="flex-1 min-w-0 flex items-center gap-1.5">
                    <span className="min-w-0 truncate">
                      <span className={isMissing ? 'text-[var(--muted-foreground)]' : ''}>
                        {notebook.name}
                      </span>
                      {isMissing && (
                        <>
                          <span className="text-[var(--muted-foreground)]">{' '}</span>
                          <span className="text-[var(--muted-foreground)]">
                            {t('status.invalid')}
                          </span>
                        </>
                      )}
                    </span>
                  </div>
                  {/* 选中对勾 ── 折叠态下列表只剩选中行这一条, 对勾已无标识
                      意义, 故折叠时不渲染。展开态多行并存时才显示。 */}
                  {(isCloudSynced || (isActive && !notebookListCollapsed)) && (
                    <div className="pointer-events-none absolute right-1.5 top-1/2 z-10 flex -translate-y-1/2 items-center transition-opacity group-hover:opacity-0">
                      {isCloudSynced && (
                        <span
                          className="flex h-6 w-6 items-center justify-center"
                          title={
                            cloudSyncStatus?.lastError
                              ? cloudSyncErrorMessage(cloudSyncStatus.lastError, t)
                              : cloudSyncInProgress
                                ? t('notebook.cloudSync.syncing')
                                : cloudSyncStatus?.state === 'success'
                                  ? t('notebook.cloudSync.complete')
                                  : t('notebook.cloudSync.title')
                          }
                        >
                          {cloudSyncInProgress ? (
                            <LoaderCircle
                              className="h-3.5 w-3.5 animate-spin text-[var(--primary)]"
                              aria-label={t('notebook.cloudSync.syncing')}
                            />
                          ) : cloudSyncStatus?.state === 'error' ? (
                            <CircleAlert
                              className="h-3.5 w-3.5 text-[var(--destructive)]"
                              aria-label={t('notebook.cloudSync.syncFailed')}
                            />
                          ) : cloudSyncStatus?.state === 'success' ? (
                            <Check
                              className="h-3.5 w-3.5 text-[var(--primary)]"
                              aria-label={t('notebook.cloudSync.complete')}
                            />
                          ) : (
                            <Cloud
                              className="h-3.5 w-3.5 text-[var(--primary)]"
                              aria-label={t('notebook.cloudSync.title')}
                            />
                          )}
                        </span>
                      )}
                      {isActive && !notebookListCollapsed && (
                        <span className="flex h-6 w-6 items-center justify-center">
                          <Check className="h-3.5 w-3.5 text-[var(--primary)]" />
                        </span>
                      )}
                    </div>
                  )}
                  {/* 编辑 ── 与 NotebookSwitcher 行内操作保持一致,
                      absolute 定位 + group-hover 渐显。删除入口已迁到
                      编辑弹窗的「移除」按钮, 列表行不再提供。 */}
                  <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <span
                      role="button"
                      tabIndex={-1}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        onEditNotebook(notebook);
                      }}
                      className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--agent-bg)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] cursor-pointer"
                      aria-label={t('status.editNotebook')}
                    >
                      <Pencil className="h-3 w-3" />
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
        {/* 「新建笔记本」按钮 ── 放在滚动列表内最下方, 与列表项一同滚动,
            取消外框与居中, 改为左侧对齐, 容器 / 图标 / 文本节奏与标签行一致。 */}
        <button
          type="button"
          onClick={handleCreateNotebookClick}
          className={cn(
            'group relative mt-0.5 flex h-8 w-full cursor-pointer select-none items-center gap-2 rounded-md pl-1.5 pr-2 text-left text-sm transition-colors',
            'text-[var(--muted-foreground)] hover:bg-[var(--muted)]',
            notebookListCollapsed && 'hidden',
          )}
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--muted)] text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]">
            <Plus className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0 flex-1 truncate">{t('status.new')}</span>
        </button>

      {/* 笔记本 ghost ── fixed 跟手, pointer-events: none 避免干扰命中测试。
          仅当处于拖动态时挂载, 模仿 tag 那段 ghost 的视觉骨架。 */}
      {notebookDragGhost && (
        (() => {
          const nb = notebooks.find((n) => n.id === notebookDragGhost.id);
          if (!nb) return null;
          return (
            <div
              aria-hidden
              className="pointer-events-none fixed z-[1600] flex h-8 items-center gap-2 rounded-md border border-[var(--primary)] bg-[var(--background)]/95 pl-1.5 pr-2 text-sm shadow-lg"
              style={{
                top: notebookDragGhost.currentY + 12,
                left: notebookDragGhost.currentX + 12,
                width: notebookDragGhost.rect.width,
                height: notebookDragGhost.rect.height,
              }}
            >
              <NotebookIcon
                icon={nb.icon}
                name={nb.name}
                className="h-6 w-6 rounded-md bg-[var(--muted)] text-[11px] font-semibold text-[var(--secondary-foreground)]"
                imageClassName="h-[72%] w-[72%]"
              />
              <span className="min-w-0 flex-1 truncate">{nb.name}</span>
            </div>
          );
        })()
      )}
      </OverlayScrollbar>
      {/* 折叠/展开笔记本列表 ── 折叠后仅展示选中的笔记本, 隐藏其余与「新建」按钮。 */}
      <button
        type="button"
        onClick={toggleNotebookListCollapse}
        aria-expanded={!notebookListCollapsed}
        aria-label={notebookListCollapsed ? t('memo.navigation.expandNotebookList') : t('memo.navigation.collapseNotebookList')}
        className={cn(
          "group relative flex h-4 w-full cursor-pointer select-none items-center justify-center text-[var(--muted-foreground)] transition-all duration-200 hover:text-[color-mix(in_oklch,var(--foreground)_30%,var(--muted-foreground))]",
          notebookListCollapsed ? "mt-0 -mb-2" : "mt-0.5 mb-1",
        )}
      >
        {/* 默认横线; hover 露出八字 (展开态 ⌃ 收起 / 折叠态 ⌄ 展开, 朝向相反, 张开角约 150°), 粗细 3 / 长度 +30% */}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" aria-hidden="true" className="h-3.5 w-3.5 opacity-30 transition-opacity duration-200 group-hover:opacity-0">
          <path d="M1.71 12 L22.29 12" />
        </svg>
        {notebookListCollapsed ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="absolute left-1/2 top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            <path d="M2.06 10.67 L12 13.33 L21.94 10.67" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="absolute left-1/2 top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            <path d="M2.06 13.33 L12 10.67 L21.94 13.33" />
          </svg>
        )}
      </button>
    </div>
  );
}
