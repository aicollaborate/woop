'use client';

import { displayTitleFromFilename } from '@/lib/utils';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useShortcutScope, pushHandler } from '@features/shortcuts';
import { SquarePen, Search, ChevronDown, Check, ChevronRight, Loader2 } from 'lucide-react';
import { useDocumentStore } from '@features/document';
import {
  type AgentConversationInstance,
} from '@features/agent/store';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import {
  selectRunningAgentConversations,
  useConversationRunIndex,
} from '@features/agent/store/conversation-run-index';
import {
  getVisibleCreateFilter,
  getNotebookIconOption,
  MEMO_COLOR_HEX,
  useMemoLibraryMetadataStore,
  useMemoStore,
  useTagStore,
  type ColorFilterValue,
  type MemoColor,
  type MemoItem,
  type Notebook,
} from '@features/memo';
import { resolveSelectedTagId } from '@features/memo/services/memo-list-metadata-service';
import { useTauriRpc } from '@platform/tauri/use-tauri-rpc';
import {
  cloud,
  listenToCloudStateChanges,
  windows as tauriWindows,
  type CloudNotebook,
} from '@platform/tauri/client';
import { useMemoInsertAnimation } from '@features/memo/hooks/use-memo-insert-animation';
import { useCreateNotebookFlow } from '@features/memo/hooks/use-create-notebook-flow';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Button } from '@shared/ui/button';
import { Tooltip } from '@shared/ui/tooltip';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { MemoCard } from '@features/memo/components/memo-card';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from '@shared/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@shared/ui/dialog';
import { Kbd } from '@shared/ui/kbd';
import { LazyGlobalSearchCommand } from '@features/memo/components/lazy-global-search-command';
import { openMemoSession } from '@features/memo/components/open-memo-session';
import {
  getMemoListQueryKey,
  shouldShowMemoListLoading,
} from '@features/memo/components/memo-list-loading-state';
import { memoRepository, notebookRepository } from '@features/memo/services/memo-repository';
import { useI18n, type I18nParams } from '@/lib/i18n';
import { useUserSettingsStore } from '@features/preferences/store/user-settings-store';
import { createLogger } from '@/lib/logger';
import { cloudSyncErrorMessage } from '@platform/tauri/errors';

import {
  COLOR_LABEL_KEYS,
  ColorFilterSubmenu,
} from './memo-list/color-filter-submenu';
import { useMemoListWindow } from './memo-list/use-memo-list-window';
const logger = createLogger('memo-list');

const LazyNotebookDialogs = lazy(() =>
  import('@features/memo/components/notebook-dialogs').then((module) => ({
    default: module.NotebookDialogs,
  })),
);

function normalizeNotebookIconId(icon: string | null | undefined): string | null {
  return getNotebookIconOption(icon) ? icon! : null;
}

const HEADER_ICON_BTN_CLASS =
  'h-8 w-8 justify-center rounded-full p-0 border border-[var(--border)] ' +
  'hover:bg-[var(--muted)] hover:text-[var(--primary)] text-[var(--foreground)]';

function BlockingLoadingOverlay({ text }: { text: string }) {
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-[color-mix(in_oklch,var(--card)_82%,transparent)] backdrop-blur-[1px]">
      <div className="flex items-center gap-2 px-3 py-2 text-sm text-[var(--foreground)]">
        <Loader2 className="h-4 w-4 animate-spin text-[var(--primary)]" />
        <span>{text}</span>
      </div>
    </div>
  );
}

/**
 * 删除确认弹窗的快捷键桥接。
 *
 * - 仅在 deleteMemo 非空时挂载 — useShortcutScope('dialog') 随之 push,
 *   pushHandler 注册的 cancel / confirm 也在栈顶, 弹窗关闭时整个子组件
 *   卸载, scope 与 handler 自动 pop, 不影响后续弹窗。
 * - 渲染 null — 这是一个逻辑组件, 没有任何 UI。
 */
function DeleteDialogShortcuts({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useShortcutScope('dialog');
  useEffect(() => {
    const popCancel = pushHandler('dialog.cancel', onCancel);
    const popConfirm = pushHandler('dialog.confirm', () => {
      // 防御: 焦点在可编辑元素时, 不应替用户做"确认"决定 (原 memo-list.tsx:251
      // 的 defensive 逻辑)。返回 false 让 Provider 跳过 preventDefault, 用户
      // 的 Enter 会落到浏览器默认 (textarea 换行 / input 提交)。
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.isContentEditable)
      ) {
        return false;
      }
      onConfirm();
    });
    return () => {
      popCancel();
      popConfirm();
    };
  }, [onCancel, onConfirm]);
  return null;
}

function EmptyState() {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 text-[var(--muted-foreground)]">
      <span className="text-sm">{t("memo.list.emptyNotFound")}</span>
    </div>
  );
}

export function MemoList() {
  const { request } = useTauriRpc();
  const { t } = useI18n();
  const { registerCard, prepareForInsert, onListRendered } =
    useMemoInsertAnimation();
  // 滚动容器 ── 普通文档流, 内部 flex-col 让 row 高度由内容撑开。
  // 之前由 useMemoInsertAnimation 提供, 现在它的 hook 不再需要这个 ref,
  // 由 consumer 自己管。
  const listContainerRef = useRef<HTMLDivElement>(null);
  // 切片订阅: 替代原来的 `useMemoStore()` 全量订阅。每个 useStore 只取用到的字段,
  // 切到 selector 后, 列表里 5k 笔记的任何 set 都不会让本组件不必要地重渲 ──
  // memos 是大头, 但要 memoize (Array equality) 才能跳过 5k 项深比; 不然
  // store 里 setNotebooks 之类也会触发 memos selector 重跑。Zustand v5 默认
  // 用 Object.is 比对, 同一个 memos 引用相等就跳过, 不需要 useMemo。
  const memos = useMemoStore((s) => s.memos);
  const notebooks = useMemoStore((s) => s.notebooks);
  const selectedMemo = useMemoStore((s) => s.selectedMemo);
  const memoCardVariant = useUserSettingsStore((s) => s.settings.memoCardVariant);
  const selectedNotebook = useMemoStore((s) => s.selectedNotebook);
  const refreshTrigger = useMemoStore((s) => s.refreshTrigger);
  const activeFilter = useMemoStore((s) => s.activeFilter);
  const activeSort = useMemoStore((s) => s.activeSort);
  const colorFilter = useMemoStore((s) => s.colorFilter);
  const selectedNotebookId = selectedNotebook?.id;
  const selectedTagId = useTagStore((s) => s.selectedTagId);
  const tagMetadataRefreshVersion = useTagStore((s) => s.metadataRefreshVersion);
  const agentConversationInstances = useAgentSessionStore(
    (s) => s.conversationRegistry.instances,
  );
  const conversationRunIndex = useConversationRunIndex(agentConversationInstances);
  const runningAgentInstances = useMemo(
    () =>
      selectRunningAgentConversations(
        { instances: agentConversationInstances },
        conversationRunIndex,
      ),
    [agentConversationInstances, conversationRunIndex],
  );
  const getRunningAgentForMemo = useCallback(
    (memo: MemoItem): AgentConversationInstance | null => {
      const memoThreadIds = new Set(memo.agents.map((agent) => agent.threadId));
      return (
        runningAgentInstances.find((instance) => {
          if (instance.source.memoId === memo.id) return true;
          return Boolean(instance.threadId && memoThreadIds.has(instance.threadId));
        }) ?? null
      );
    },
    [runningAgentInstances],
  );
  const activeTagId = activeFilter === 'tagged' ? selectedTagId : null;
  const setSelectedTagId = useTagStore((s) => s.setSelectedTagId);
  const loadLibraryMetadata = useMemoLibraryMetadataStore((s) => s.loadMetadata);
  const {
    setSelectedMemo,
    setSelectedNotebook,
    triggerRefresh,
    setMemos,
    setNotebooks,
    setActiveFilter,
    setActiveSort,
    setColorFilter,
    loadMemos,
    handleMemoCreated,
  } = useMemoStore(
    useShallow((s) => ({
      setSelectedMemo: s.setSelectedMemo,
      setSelectedNotebook: s.setSelectedNotebook,
      triggerRefresh: s.triggerRefresh,
      setMemos: s.setMemos,
      setNotebooks: s.setNotebooks,
      setActiveFilter: s.setActiveFilter,
      setActiveSort: s.setActiveSort,
      setColorFilter: s.setColorFilter,
      loadMemos: s.loadMemos,
      handleMemoCreated: s.handleMemoCreated,
    })),
  );
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [deleteMemo, setDeleteMemo] = useState<MemoItem | null>(null);
  const [createNotebookOpen, setCreateNotebookOpen] = useState(false);
  const [notebookDropdownOpen, setNotebookDropdownOpen] = useState(false);
  const [searchCommandOpen, setSearchCommandOpen] = useState(false);
  const [colorSubmenuOpen, setColorSubmenuOpen] = useState(false);
  const colorTriggerRef = useRef<HTMLButtonElement>(null);
  const colorSubmenuCloseTimerRef = useRef<number | null>(null);
  const [newNotebookName, setNewNotebookName] = useState('');
  const [newNotebookPath, setNewNotebookPath] = useState('');
  const [newNotebookIcon, setNewNotebookIcon] = useState<string | null>(null);
  const [createNotebookMode, setCreateNotebookMode] = useState<'create' | 'cloud'>('create');
  const [remoteNotebooks, setRemoteNotebooks] = useState<CloudNotebook[]>([]);
  const [remoteNotebooksLoading, setRemoteNotebooksLoading] = useState(false);
  const [remoteNotebookSyncingId, setRemoteNotebookSyncingId] = useState<string | null>(null);
  const [editNotebookOpen, setEditNotebookOpen] = useState(false);
  const [editingNotebook, setEditingNotebook] = useState<Notebook | null>(null);
  const [editNotebookName, setEditNotebookName] = useState('');
  const [editNotebookIcon, setEditNotebookIcon] = useState<string | null>(null);
  const [editNotebookCloudSync, setEditNotebookCloudSync] = useState(false);
  const [originalEditNotebookCloudSync, setOriginalEditNotebookCloudSync] = useState(false);
  const [cloudSyncAvailable, setCloudSyncAvailable] = useState(false);
  const [tagMap, setTagMap] = useState<Record<string, string>>({});
  const [isMemoListLoading, setIsMemoListLoading] = useState(false);
  const [loadedMemoListQueryKey, setLoadedMemoListQueryKey] = useState<string | null>(null);
  const loadDataSeqRef = useRef(0);
  const emptyNotebookPromptedRef = useRef(false);
  const { blockingLoadingText, createNotebook } = useCreateNotebookFlow({
    onMemoListReloadNeeded: triggerRefresh,
    onMemoListQueryReset: () => setLoadedMemoListQueryKey(null),
    onMemoListLoadingChange: setIsMemoListLoading,
  });

  useEffect(() => {
    if (!editNotebookOpen || !editingNotebook) return;
    let cancelled = false;
    void Promise.all([
      cloud.getState(),
      cloud.getNotebookState(editingNotebook.id),
    ])
      .then(([cloudState, link]) => {
        if (cancelled) return;
        const enabled = Boolean(link?.enabled);
        setCloudSyncAvailable(cloudState.authenticated && cloudState.enabled);
        setEditNotebookCloudSync(enabled);
        setOriginalEditNotebookCloudSync(enabled);
      })
      .catch(() => {
        if (!cancelled) setCloudSyncAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editNotebookOpen, editingNotebook]);

  useEffect(() => {
    return listenToCloudStateChanges((cloudState) => {
      setCloudSyncAvailable(cloudState.authenticated && cloudState.enabled);
    });
  }, []);

  // 全局事件监听器 ── 跨组件 shortcut / dispatchEvent 解耦点。
  // MemoList 始终挂载（侧栏收起时只是切换为隐藏/浮层形态），因此这些监听器
  // 只有一份，不需要跨实例去重。
  useEffect(() => {
    const cleanups: Array<() => void> = [];
    const handleOpenNotebook = () => {
      setNewNotebookName('');
      setNewNotebookPath('');
      setNewNotebookIcon(null);
      setCreateNotebookMode('create');
      setRemoteNotebooks([]);
      setRemoteNotebooksLoading(false);
      setRemoteNotebookSyncingId(null);
      setCreateNotebookOpen(true);
    };
    window.addEventListener('flowix:open-create-notebook', handleOpenNotebook);
    cleanups.push(() => window.removeEventListener('flowix:open-create-notebook', handleOpenNotebook));
    const handleEditNotebook = (event: Event) => {
      const ce = event as CustomEvent<Notebook>;
      const notebook = ce.detail;
      if (!notebook) return;
      setEditingNotebook(notebook);
      setEditNotebookName(notebook.name);
      setEditNotebookIcon(normalizeNotebookIconId(notebook.icon));
      setEditNotebookOpen(true);
    };
    window.addEventListener('flowix:open-edit-notebook', handleEditNotebook as EventListener);
    cleanups.push(() => window.removeEventListener('flowix:open-edit-notebook', handleEditNotebook as EventListener));
    const handleRequestDelete = (event: Event) => {
      const ce = event as CustomEvent<MemoItem>;
      const memo = ce.detail;
      if (!memo) return;
      setDeleteMemo(memo);
    };
    window.addEventListener('flowix:request-delete-memo', handleRequestDelete as EventListener);
    cleanups.push(() => window.removeEventListener('flowix:request-delete-memo', handleRequestDelete as EventListener));
    const handleTogglePalette = () => setSearchCommandOpen(prev => !prev);
    window.addEventListener('flowix:toggle-palette', handleTogglePalette);
    cleanups.push(() => window.removeEventListener('flowix:toggle-palette', handleTogglePalette));
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, []);

  // Shared delete path for both the dialog button and Enter shortcut.
  const handleDeleteConfirm = useCallback(() => {
    if (!deleteMemo) return;
    const memo = deleteMemo;
    setDeleteMemo(null);
    void memoRepository.delete(memo.id).then(() => {
      if (selectedMemo?.id === memo.id) {
        setSelectedMemo(null);
        useDocumentStore.getState().clearDocument();
      }
      triggerRefresh();
    });
  }, [deleteMemo, selectedMemo, setSelectedMemo, triggerRefresh]);

  const handleDeleteCancel = useCallback(() => {
    setDeleteMemo(null);
  }, []);

  const loadData = useCallback(async () => {
    const loadSeq = ++loadDataSeqRef.current;
    const state = useMemoStore.getState();
    let currentNotebook = state.selectedNotebook;

    const notebooksResult = await notebookRepository.list();
    if (!notebooksResult || notebooksResult.length === 0) {
      setNotebooks([]);
      setSelectedNotebook(null);
      setSelectedMemo(null);
      setMemos([]);
      useDocumentStore.getState().clearDocument();
      setSelectedTagId(null);
      setLoadedMemoListQueryKey(null);
      setIsMemoListLoading(false);
      if (!emptyNotebookPromptedRef.current) {
        emptyNotebookPromptedRef.current = true;
        setCreateNotebookOpen(true);
      }
      return;
    }
    setNotebooks(notebooksResult);

    if (currentNotebook) {
      const currentId = currentNotebook.id;
      const exists = notebooksResult.some((n: Notebook) => n.id === currentId);
      if (exists) {
        currentNotebook = notebooksResult.find((n: Notebook) => n.id === currentId) || null;
        if (currentNotebook) {
          setSelectedNotebook(currentNotebook);
        }
      } else {
        const nextNotebook = notebooksResult[0];
        setSelectedNotebook(nextNotebook);
        currentNotebook = nextNotebook;
      }
    } else {
      const nextNotebook = notebooksResult[0];
      setSelectedNotebook(nextNotebook);
      currentNotebook = nextNotebook;
    }

    if (!currentNotebook) {
      return;
    }

    const libraryMetadata = await loadLibraryMetadata(
      currentNotebook,
      tagMetadataRefreshVersion
    );
    if (!libraryMetadata) return;
    if (loadSeq !== loadDataSeqRef.current) return;
    if (useMemoStore.getState().selectedNotebook?.id !== currentNotebook.id) return;

    setTagMap(libraryMetadata.tagMap);

    // selectedTagId 校验: 防止 useTagStore 持久化残留 "已不存在的 tag" 选中态。
    // 用当前 selectedTagId 重新校验 (而非 loadData 开头取的旧值): IPC 期间
    // selectedTagId 可能已变 (重命名 commitRename 更新到新 fullPath), 用旧值
    // 校验出的 null 会覆盖新值, 选中态丢成"全部"。
    const latestSelectedTagId = useTagStore.getState().selectedTagId;
    const resolvedSelectedTagId = resolveSelectedTagId(latestSelectedTagId, libraryMetadata.tagOptions);
    if (resolvedSelectedTagId !== latestSelectedTagId) {
      setSelectedTagId(resolvedSelectedTagId);
    }

  }, [loadLibraryMetadata, setNotebooks, setSelectedNotebook, setSelectedTagId, tagMetadataRefreshVersion]);

  useEffect(() => {
    void loadData().catch((error) => {
      logger.warn('load list metadata failed', { error });
      toast.error(t('memo.list.loadFailed'));
    });
  }, [loadData, refreshTrigger, selectedNotebookId]);

  useEffect(() => {
    let cancelled = false;
    const queryKey = getMemoListQueryKey(
      selectedNotebookId,
      activeFilter,
      activeSort,
      activeTagId,
      colorFilter
    );
    const shouldShowLoading = queryKey !== loadedMemoListQueryKey;

    async function loadMemoListOnly() {
      if (shouldShowLoading) {
        setIsMemoListLoading(true);
      }
      try {
        await loadMemos({
          notebookId: selectedNotebookId,
          filter: activeFilter,
          sort: activeSort,
          tagId: activeTagId ?? undefined,
        });
        if (cancelled) return;
        setLoadedMemoListQueryKey(queryKey);
        const latestMemoState = useMemoStore.getState();
        const latestDocumentState = useDocumentStore.getState();
        if (
          !latestMemoState.selectedMemo &&
          !latestDocumentState.activeMemoSession &&
          latestDocumentState.currentDocumentSource !== 'external'
        ) {
          latestDocumentState.clearDocument();
        }
      } catch (error) {
        if (!cancelled) {
          logger.warn('load memos failed', { error });
          toast.error(t('memo.list.loadFailed'));
        }
      } finally {
        if (!cancelled) {
          setIsMemoListLoading(false);
        }
      }
    }

    void loadMemoListOnly();

    return () => {
      cancelled = true;
    };
  }, [activeFilter, activeSort, activeTagId, colorFilter, loadMemos, refreshTrigger, selectedNotebookId]);

  const currentMemoListQueryKey = getMemoListQueryKey(
    selectedNotebookId,
    activeFilter,
    activeSort,
    activeTagId,
    colorFilter
  );
  const showMemoListLoading = shouldShowMemoListLoading({
    selectedNotebookId,
    isMemoListLoading,
    currentMemoListQueryKey,
    loadedMemoListQueryKey,
  });
  const visibleLoadingText = blockingLoadingText;
  // 选中标签的展示名: tagMap 只收录真实 tag (id = 完整路径, 如
  // "Flowix/云存储"), 不含路径前缀 segment。选中父节点 (e.g. "Flowix")
  // 时 selectedTagId = fullPath "Flowix" 是前缀而非任何 memo 的真实 tag,
  // tagMap 取不到, fallback 到 activeTagId (即 fullPath) 本身展示 ──
  // 与 memo-card 的 `tagMap[tagId] || tagId` 同模式。
  const activeTagName = activeTagId ? (tagMap[activeTagId] ?? activeTagId) : null;

  // 顶部标题文案: 有筛选条件时只展示筛选后缀 (如 "#云存储" / "待办"), 不再带
  // 笔记本名或"全部"前缀; 无任何筛选时展示"全部"。thisWeek/thisMonth 同样计入
  // 筛选条件, 避免选了"只看本周"顶部却仍显示"全部"的误导。tagged 但无具体 tag
  // (activeTagName 为空) 时退回"全部"。
  const { headerLabel, hasActiveFilter } = (() => {
    const parts: string[] = [];
    // tag 保留 "#" 前缀; 其余筛选 (待办/对话/颜色/只看本周/只看本月) 仅展示文案,
    // 不带 "@" 前缀。
    if (activeTagName) parts.push(`#${activeTagName}`);
    if (activeFilter === 'todos') parts.push(t('memo.list.filterTasks'));
    if (activeFilter === 'agents') parts.push(t('memo.list.filterAgents'));
    if (activeFilter === 'color') {
      const colorLabel =
        colorFilter === 'any'
          ? t('memo.list.filterColorAny')
          : colorFilter === 'none'
            ? t('document.color.noColorTooltip')
            : t(COLOR_LABEL_KEYS[colorFilter]);
      parts.push(colorLabel);
    }
    if (activeFilter === 'thisWeek') parts.push(t('memo.list.filterThisWeek'));
    if (activeFilter === 'thisMonth') parts.push(t('memo.list.filterThisMonth'));
    return parts.length > 0
      ? { headerLabel: parts.join(' '), hasActiveFilter: true }
      : { headerLabel: t('memo.list.filterAll'), hasActiveFilter: false };
  })();

  // 'color' 是前端专用 filter — 后端返回全量, 这里按 `colorFilter` 二次过滤:
  //   'any'  → memo.colors.length > 0
  //   'none' → memo.colors.length === 0
  //   具体颜色 → memo.colors.includes(c)
  // 仅当 activeFilter === 'color' 时启用, 其他 filter 原样透传。
  const {
    renderedMemos,
    onScroll: handleMemoListScroll,
  } = useMemoListWindow({
    memos,
    activeFilter,
    colorFilter,
    selectedMemoId: selectedMemo?.id,
    queryKey: currentMemoListQueryKey,
    loading: showMemoListLoading,
    scrollerRef: listContainerRef,
  });

  // ─── row ref 缓存 ──────────────────────────────────────────────
  // 同一 memo.id 跨 render 拿到**稳定**的 ref 回调, 避免 React 在重渲时
  // 反复调 null/node (虽然没了 virtualizer, 但 useMemoInsertAnimation 仍
  // 通过 cardRefs 拿节点做入场动画, 稳定 ref 让它能稳定命中)。
  const rowRefCacheRef = useRef<
    Map<string, (el: HTMLDivElement | null) => void>
  >(new Map());
  const registerCardRef = useRef(registerCard);
  registerCardRef.current = registerCard;
  const getMemoRowRef = (id: string) => {
    const cached = rowRefCacheRef.current.get(id);
    if (cached) return cached;
    const cb = (el: HTMLDivElement | null) => {
      registerCardRef.current(id)(el);
      if (!el) rowRefCacheRef.current.delete(id);
    };
    rowRefCacheRef.current.set(id, cb);
    return cb;
  };
  const handleSelectMemo = useCallback((memo: MemoItem) => {
    openMemoSession(memo, useMemoStore.getState().selectedNotebook);
  }, []);

  const handleOpenMemoWindow = useCallback((memo: MemoItem) => {
    void tauriWindows.openNoteTab(memo.id).catch((error) => {
      logger.warn('open note window failed', { error });
      toast.error(String(error));
    });
  }, []);

  const handleFavoriteToggle = useCallback(async (memo: MemoItem) => {
    await (memo.favorited
      ? memoRepository.unfavorite(memo.id)
      : memoRepository.favorite(memo.id));
    triggerRefresh();
  }, [triggerRefresh]);

  const handleColorsChange = useCallback(async (memo: MemoItem, colors: MemoColor[]) => {
    await memoRepository.setColors(memo.id, colors);
  }, []);

  const handleFilterChange = (filter: typeof activeFilter) => {
    if (filter !== 'tagged') {
      setSelectedTagId(null);
    }
    // 切到非 color filter 时, 保留 colorFilter 值, 切回时恢复 — 用户预期
    // 切到其他筛选再回来, 之前选的颜色还在。
    setActiveFilter(filter);
  };

  // 颜色二级弹窗的选中回调: 同步 activeFilter='color' + colorFilter, 同时
  // 显式关掉父 dropdown (子菜单 onMouseDown 阻止了冒泡, 父 dropdown
  // setOpen 不会自动触发, 需要手动 setNotebookDropdownOpen(false))。
  const handleColorSubmenuSelect = useCallback(
    (value: ColorFilterValue) => {
      setSelectedTagId(null);
      setColorFilter(value);
      setActiveFilter('color');
      setColorSubmenuOpen(false);
      setNotebookDropdownOpen(false);
    },
    [setActiveFilter, setColorFilter, setSelectedTagId, setNotebookDropdownOpen],
  );

  // 当 dropdown 关闭时, 同步把 color submenu 也收掉, 避免残留 portal 节点
  useEffect(() => {
    if (!notebookDropdownOpen) {
      setColorSubmenuOpen(false);
      if (colorSubmenuCloseTimerRef.current) {
        window.clearTimeout(colorSubmenuCloseTimerRef.current);
        colorSubmenuCloseTimerRef.current = null;
      }
    }
  }, [notebookDropdownOpen]);

  const handleSortChange = (sort: typeof activeSort) => {
    setActiveSort(sort);
  };

  const handleCreateMemo = useCallback(async () => {
    if (!selectedNotebook) return;
    const previousSelectedMemo = useMemoStore.getState().selectedMemo;
    const createFilter = getVisibleCreateFilter(activeFilter);
    if (createFilter !== activeFilter) {
      setSelectedTagId(null);
      setActiveFilter(createFilter);
    }
    setSelectedMemo(null);

    let result: MemoItem;
    try {
      result = await memoRepository.create(activeTagId ?? undefined, selectedNotebook.id);
    } catch (error) {
      setSelectedMemo(previousSelectedMemo);
      throw error;
    }

    if (!result) {
      setSelectedMemo(previousSelectedMemo);
      return;
    }

    const newMemo = result;
    const shouldSelectNewMemo =
      createFilter === 'all' ||
      (createFilter === 'tagged' && Boolean(activeTagId)) ||
      createFilter === 'thisWeek' ||
      createFilter === 'thisMonth';

    // Synchronously capture pre-render positions BEFORE the store update that
    // adds the new memo. The animation itself runs in the useLayoutEffect below,
    // after React commits the new list but before the browser paints it.
    // 现在没有虚拟列表, 新 memo 永远渲染在列表最前 ── 入场动画交给
    // useMemoInsertAnimation.onListRendered 在 layout 阶段跑一次。
    prepareForInsert(newMemo.id);
    handleMemoCreated(newMemo, { select: shouldSelectNewMemo });

    if (shouldSelectNewMemo) {
      openMemoSession({ ...newMemo, isOpen: true }, selectedNotebook);
    }
  }, [
    activeFilter,
    activeTagId,
    handleMemoCreated,
    prepareForInsert,
    selectedNotebook,
    setActiveFilter,
    setSelectedMemo,
    setSelectedTagId,
  ]);

  useEffect(() => {
    const handleRequest = () => {
      void handleCreateMemo();
    };
    window.addEventListener('flowix:create-memo', handleRequest);
    return () => window.removeEventListener('flowix:create-memo', handleRequest);
  }, [handleCreateMemo]);

  // 入场动画入口: 每次 memos 变化时 (含新建/更新/删除) 在 layout 阶段同步
  // 询问 useMemoInsertAnimation 是否有 pending 新 card, 有就跑一次入场
  // 动画; 无就是 no-op。 在 paint 之前跑, 避免首帧闪烁。
  useLayoutEffect(() => {
    onListRendered();
  }, [memos, onListRendered]);

  const handleOpenRemoteNotebooks = async () => {
    try {
      const cloudState = await cloud.getState();
      setCloudSyncAvailable(cloudState.authenticated && cloudState.enabled);
      if (!cloudState.authenticated) {
        setCreateNotebookOpen(false);
        await tauriWindows.openPreferences('cloudSync');
        return;
      }
      setCreateNotebookMode('cloud');
      setRemoteNotebooksLoading(true);
      const notebooks = await cloud.listNotebooks();
      setRemoteNotebooks(notebooks);
    } catch (error) {
      toast.error(cloudSyncErrorMessage(error, t));
    } finally {
      setRemoteNotebooksLoading(false);
    }
  };

  const handleSelectRemoteNotebook = async (remoteNotebook: CloudNotebook) => {
    if (remoteNotebook.synced || remoteNotebookSyncingId) return;
    try {
      setRemoteNotebookSyncingId(remoteNotebook.id);
      const existing = notebooks.find((notebook) => notebook.id === remoteNotebook.id);
      let localNotebook = existing;
      if (!localNotebook) {
        const path = await request<string | null>('select_directory');
        if (!path) return;
        setCreateNotebookOpen(false);
        localNotebook = await createNotebook({
          cloudNotebookId: remoteNotebook.id,
          name: remoteNotebook.name,
          path,
          icon: normalizeNotebookIconId(remoteNotebook.icon),
        }) ?? undefined;
      } else {
        setCreateNotebookOpen(false);
      }
      if (!localNotebook) return;
      await cloud.linkNotebook(localNotebook.id, remoteNotebook.id);
      await cloud.syncNow(localNotebook.id);
      triggerRefresh();
      toast.success(t('notebook.cloudImport.complete'));
    } catch (error) {
      toast.error(cloudSyncErrorMessage(error, t));
    } finally {
      setRemoteNotebookSyncingId(null);
      setCreateNotebookMode('create');
      setRemoteNotebooks([]);
    }
  };

  const handleConfirmCreateNotebook = async () => {
    if (!newNotebookName.trim() || !newNotebookPath.trim()) return;

    setCreateNotebookOpen(false);
    const created = await createNotebook({
      name: newNotebookName,
      path: newNotebookPath,
      icon: newNotebookIcon,
    });
    if (created) {
      setNewNotebookName('');
      setNewNotebookPath('');
      setNewNotebookIcon(null);
    }
  };

  const handleConfirmEditNotebook = async () => {
    if (!editingNotebook) return;
    const trimmed = editNotebookName.trim();
    const nextIcon = editNotebookIcon || null;
    const currentIcon = normalizeNotebookIconId(editingNotebook.icon);
    const iconChanged = (nextIcon ?? '') !== (currentIcon ?? '');
    const cloudSyncChanged =
      editNotebookCloudSync !== originalEditNotebookCloudSync;
    const notebookMetadataChanged =
      trimmed !== editingNotebook.name || iconChanged;
    if (!trimmed || (!notebookMetadataChanged && !cloudSyncChanged)) {
      setEditNotebookOpen(false);
      setEditingNotebook(null);
      setEditNotebookName('');
      setEditNotebookIcon(null);
      return;
    }
    try {
      const updated = notebookMetadataChanged
        ? await notebookRepository.update(editingNotebook.id, trimmed, nextIcon ?? '')
        : editingNotebook;
      if (updated) {
        if (cloudSyncChanged) {
          await cloud.setNotebookEnabled(editingNotebook.id, editNotebookCloudSync);
          if (editNotebookCloudSync) {
            await cloud.syncNow(editingNotebook.id);
          }
        }
        toast.success(t('memo.list.updated'));
        // 同步更新列表
        setNotebooks(
          useMemoStore.getState().notebooks.map((nb) => (nb.id === updated.id ? updated : nb))
        );
        // 同步更新当前选中项, 让顶部按钮立即反映新名称
        if (useMemoStore.getState().selectedNotebook?.id === updated.id) {
          setSelectedNotebook(updated);
        }
        setEditNotebookOpen(false);
        setEditingNotebook(null);
        setEditNotebookName('');
        setEditNotebookIcon(null);
        setEditNotebookCloudSync(false);
        setOriginalEditNotebookCloudSync(false);
      } else {
        toast.error(t('memo.list.updateFailed'));
      }
    } catch (error) {
      logger.warn('update notebook failed', { error });
      toast.error(cloudSyncErrorMessage(error, t));
    }
  };

  return (
    <div className="memo-list relative flex h-full select-none flex-col bg-[var(--card)]">
      <>
      {/* Memo Tab */}
      <div className="flex items-center justify-between pl-2 pr-3.5 pb-2 gap-2">
        <div className="min-w-0 flex-1">
          <DropdownMenu open={notebookDropdownOpen} onOpenChange={setNotebookDropdownOpen}>
            <DropdownMenuTrigger asChild>
              <button
                className="group flex max-w-full min-w-0 items-center gap-1 overflow-hidden rounded-md py-0.5 pl-1 pr-2 transition-colors"
              >
                <span
                  className="min-w-0 flex-1 truncate text-[15px] font-medium text-[var(--foreground)] transition-colors duration-150 group-hover:text-[color-mix(in_oklch,var(--foreground)_80%,white)]"
                  title={hasActiveFilter ? headerLabel : undefined}
                >
                  {headerLabel}
                </span>
                <ChevronDown className="w-3 h-3 text-[var(--muted-foreground)] shrink-0" strokeWidth={2.5} />
              </button>
            </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom" className="w-[200px] px-1 py-1 space-y-1">
            {/* Group 1: Filter Options */}
            <DropdownMenuLabel className="py-1.5 shrink-0 px-2 pt-1.5 pb-1 text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">{t('memo.list.filterLabel')}</DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() => handleFilterChange('all')}
              className="flex items-center justify-between cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
            >
              <span>{t('memo.list.filterAll')}</span>
              {activeFilter === 'all' && <Check className="w-4 h-4 text-[var(--primary)]" />}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => handleFilterChange('agents')}
              className="flex items-center justify-between cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
            >
              <span>{t('memo.list.filterAgentsOnly')}</span>
              {activeFilter === 'agents' && <Check className="w-4 h-4 text-[var(--primary)]" />}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => handleFilterChange('todos')}
              className="flex items-center justify-between cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
            >
              <span>{t('memo.list.filterTasksOnly')}</span>
              {activeFilter === 'todos' && <Check className="w-4 h-4 text-[var(--primary)]" />}
            </DropdownMenuItem>
            <button
              ref={colorTriggerRef}
              type="button"
              onMouseEnter={() => {
                if (colorSubmenuCloseTimerRef.current) {
                  window.clearTimeout(colorSubmenuCloseTimerRef.current);
                  colorSubmenuCloseTimerRef.current = null;
                }
                setColorSubmenuOpen(true);
              }}
              onMouseLeave={() => {
                if (colorSubmenuCloseTimerRef.current) {
                  window.clearTimeout(colorSubmenuCloseTimerRef.current);
                }
                colorSubmenuCloseTimerRef.current = window.setTimeout(() => {
                  setColorSubmenuOpen(false);
                  colorSubmenuCloseTimerRef.current = null;
                }, 120);
              }}
              onFocus={() => setColorSubmenuOpen(true)}
              className={cn(
                'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm text-[var(--foreground)] cursor-pointer outline-none',
                colorSubmenuOpen ? 'bg-[var(--muted)]' : 'hover:bg-[var(--muted)]',
              )}
            >
              <span className="flex items-center gap-2">
                <span>{t('memo.list.filterColorOnly')}</span>
                {activeFilter === 'color' && (
                  <span
                    aria-hidden
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{
                      backgroundColor:
                        colorFilter === 'none'
                          ? 'transparent'
                          : colorFilter === 'any'
                            ? 'var(--muted-foreground)'
                            : MEMO_COLOR_HEX[colorFilter],
                      border: '1px solid var(--border)',
                    }}
                  />
                )}
              </span>
              <span className="flex items-center gap-1.5">
                {activeFilter === 'color' && <Check className="w-4 h-4 text-[var(--primary)]" />}
                <ChevronRight className="w-3.5 h-3.5 text-[var(--muted-foreground)]" />
              </span>
            </button>
            <DropdownMenuItem
              onClick={() => handleFilterChange('thisWeek')}
              className="flex items-center justify-between cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
            >
              <span>{t('memo.list.filterThisWeek')}</span>
              {activeFilter === 'thisWeek' && <Check className="w-4 h-4 text-[var(--primary)]" />}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => handleFilterChange('thisMonth')}
              className="flex items-center justify-between cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
            >
              <span>{t('memo.list.filterThisMonth')}</span>
              {activeFilter === 'thisMonth' && <Check className="w-4 h-4 text-[var(--primary)]" />}
            </DropdownMenuItem>

            {/* Separator between Filter and Sort, matching the titlebar dropdown dividers */}
            <hr className="mx-2 border-t border-[var(--border)] opacity-50" />

            {/* Group 2: Sort Options */}
            <DropdownMenuLabel className="py-1.5 shrink-0 px-2 pt-1.5 pb-1 text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">{t('memo.list.sortLabel')}</DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() => handleSortChange('createdAt')}
              className="flex items-center justify-between cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
            >
              <span>{t('memo.list.sortCreated')}</span>
              {activeSort === 'createdAt' && <Check className="w-4 h-4 text-[var(--primary)]" />}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => handleSortChange('updatedAt')}
              className="flex items-center justify-between cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
            >
              <span>{t('memo.list.sortUpdated')}</span>
              {activeSort === 'updatedAt' && <Check className="w-4 h-4 text-[var(--primary)]" />}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* 注意: 必须放在 <DropdownMenu> 外面 — 父 dropdown 的 mousedown 监听
            触发 setOpen(false) 时会卸载 DropdownMenuContent, 进而卸载内部
            子组件, ColorFilterSubmenu 的 portal 节点被从 body 移除; 此时
            mousedown 后接的 click 落在已脱离 DOM 的按钮上, React 看不到
            onClick 触发, 状态就没被 set, 筛选当然不生效。 提到外层后,
            即使父 dropdown 关闭, 子菜单组件仍由 MemoList 持有, portal
            节点稳定, click 落到 mounted 按钮上, 走 handleSelect 正常
            setColorFilter + setActiveFilter('color')。 */}
        <ColorFilterSubmenu
          parentRef={colorTriggerRef}
          active={colorSubmenuOpen}
          onClose={() => setColorSubmenuOpen(false)}
          onCancelClose={() => {
            if (colorSubmenuCloseTimerRef.current) {
              window.clearTimeout(colorSubmenuCloseTimerRef.current);
              colorSubmenuCloseTimerRef.current = null;
            }
          }}
          value={colorFilter}
          onSelect={handleColorSubmenuSelect}
        />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Tooltip content={t("memo.list.searchTooltip")} shortcut="palette.search">
            <Button
              size="icon"
              variant="outline"
              className={cn(HEADER_ICON_BTN_CLASS, 'bg-[var(--card)]')}
              onClick={() => setSearchCommandOpen(true)}
              aria-label={t("memo.list.search")}
            >
              <Search className="w-4 h-4" />
            </Button>
          </Tooltip>
          <Tooltip content={t("memo.list.newMemoTooltip")} shortcut="memo.create">
            <Button
              size="icon"
              className="h-8 w-8 justify-center bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90 rounded-full p-0 border border-transparent"
              onClick={handleCreateMemo}
            >
              <SquarePen className="w-4 h-4 text-[var(--primary-foreground)]" />
            </Button>
          </Tooltip>
        </div>
      </div>
      </>

      <OverlayScrollbar
        className="flex min-h-0 flex-1"
        scrollerClassName="flex-1 overflow-y-auto px-1 py-2"
        scrollerRef={listContainerRef}
        onScroll={handleMemoListScroll}
      >
        {memos.length > 0 ? (
          // 普通列渲染: 父容器是 flex-col, 每张卡在文档流里自然堆叠, 高度
          // 由内容撑开, 不再用 transform 定位。 GSAP 入场动画只作用在
          // 命中的 [data-insert-anim] 节点, 不影响周围 row 的流式布局 ──
          // 物理上消除了"上下 row 重叠"的可能性。
          <div className="flex flex-col">
            {renderedMemos.map((memo) => {
              // 用 closure 缓存让同一 memo 跨 render 拿到稳定 ref, 避免
              // React 在重渲时反复卸载/挂载 ref (虽然现在没了 virtualizer
              // 测量问题, 但保持稳定仍是好习惯, 也便于 useMemoInsertAnimation
              // 通过 cardRefs 拿到正确的 row 节点)。
              const cardRef = getMemoRowRef(memo.id);
              return (
                <div
                  key={memo.id}
                  ref={cardRef}
                >
                  <div data-insert-anim>
                    <MemoCard
                      memo={memo}
                      variant={memoCardVariant}
                      tagMap={tagMap}
                      isSelected={selectedMemo?.id === memo.id}
                      isDropdownOpen={openDropdown === memo.id}
                      runningAgentType={getRunningAgentForMemo(memo)?.agentType}
                      onOpenDropdown={setOpenDropdown}
                      onSelect={handleSelectMemo}
                      onOpenInWindow={handleOpenMemoWindow}
                      onFavoriteToggle={handleFavoriteToggle}
                      onDelete={setDeleteMemo}
                      onColorsChange={handleColorsChange}
                    />
                    <hr className="mx-3 border-t border-[var(--border)] opacity-50" />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState />
        )}
      </OverlayScrollbar>

      {visibleLoadingText && <BlockingLoadingOverlay text={visibleLoadingText} />}

      {deleteMemo && (
        <DeleteDialogShortcuts
          onCancel={handleDeleteCancel}
          onConfirm={handleDeleteConfirm}
        />
      )}

      <Dialog open={!!deleteMemo} onOpenChange={(open) => !open && setDeleteMemo(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('memo.delete.title')}</DialogTitle>
            <DialogDescription>{t('memo.delete.description', { name: displayTitleFromFilename(deleteMemo?.filename) } satisfies I18nParams)}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={() => setDeleteMemo(null)}
              className="h-8 px-3 text-sm rounded-lg hover:bg-[var(--muted)]"
            >
              {t('memo.delete.cancel')}
            </button>
            <button
              type="button"
              onClick={handleDeleteConfirm}
              className="relative h-8 pl-3 pr-7 text-sm rounded-lg bg-[var(--destructive)] text-white hover:opacity-90"
            >
              {t('memo.delete.confirm')}
              <Kbd className="!text-white border-0">↵</Kbd>
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 新建 Notebook 弹窗 */}
      {(createNotebookOpen || editNotebookOpen) && (
        <Suspense fallback={null}>
          <LazyNotebookDialogs
            createOpen={createNotebookOpen}
            onCreateOpenChange={(open) => {
              if (!open) {
                setCreateNotebookMode('create');
                setRemoteNotebooks([]);
                setRemoteNotebooksLoading(false);
                setRemoteNotebookSyncingId(null);
              }
              setCreateNotebookOpen(open);
            }}
            newNotebookName={newNotebookName}
            onNewNotebookNameChange={setNewNotebookName}
            newNotebookPath={newNotebookPath}
            onNewNotebookPathChange={setNewNotebookPath}
            newNotebookIcon={newNotebookIcon}
            onNewNotebookIconChange={setNewNotebookIcon}
            cloudSyncAvailable={cloudSyncAvailable}
            createMode={createNotebookMode}
            remoteNotebooks={remoteNotebooks}
            remoteNotebooksLoading={remoteNotebooksLoading}
            remoteNotebookSyncingId={remoteNotebookSyncingId}
            onOpenRemoteNotebooks={() => {
              void handleOpenRemoteNotebooks();
            }}
            onBackToCreate={() => {
              setCreateNotebookMode('create');
              setRemoteNotebooks([]);
            }}
            onSelectRemoteNotebook={(notebook) => {
              void handleSelectRemoteNotebook(notebook);
            }}
            onSelectDirectory={async () => {
              const result = await request<string | null>('select_directory');
              if (result) setNewNotebookPath(result);
            }}
            onConfirmCreate={handleConfirmCreateNotebook}
            onCancelCreate={() => {
              setCreateNotebookOpen(false);
              setNewNotebookName('');
              setNewNotebookPath('');
              setNewNotebookIcon(null);
              setCreateNotebookMode('create');
              setRemoteNotebooks([]);
              setRemoteNotebooksLoading(false);
              setRemoteNotebookSyncingId(null);
            }}
            editOpen={editNotebookOpen}
            onEditOpenChange={(open) => {
              if (!open) {
                setEditingNotebook(null);
                setEditNotebookName('');
                setEditNotebookIcon(null);
                setEditNotebookCloudSync(false);
                setOriginalEditNotebookCloudSync(false);
              }
              setEditNotebookOpen(open);
            }}
            editingNotebook={editingNotebook}
            editNotebookName={editNotebookName}
            onEditNotebookNameChange={setEditNotebookName}
            editNotebookIcon={editNotebookIcon}
            onEditNotebookIconChange={setEditNotebookIcon}
            editNotebookCloudSync={editNotebookCloudSync}
            onEditNotebookCloudSyncChange={setEditNotebookCloudSync}
            onEditNotebookCloudSyncUnavailable={() => {
              void tauriWindows.openPreferences('cloudSync').catch((error) => {
                toast.error(`${t('notebook.cloudSync.failed')}: ${String(error)}`);
              });
            }}
            editNotebookCloudSyncChanged={
              editNotebookCloudSync !== originalEditNotebookCloudSync
            }
            onConfirmEdit={handleConfirmEditNotebook}
            onCancelEdit={() => {
              setEditNotebookOpen(false);
              setEditingNotebook(null);
              setEditNotebookName('');
              setEditNotebookIcon(null);
              setEditNotebookCloudSync(false);
              setOriginalEditNotebookCloudSync(false);
            }}
          />
        </Suspense>
      )}

      {/* 全局搜索 / 命令面板 */}
      <LazyGlobalSearchCommand open={searchCommandOpen} onOpenChange={setSearchCommandOpen} />
    </div>
  );
}
