'use client';

import { Fragment, useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { ArrowClockwiseIcon, CaretRightIcon, FolderSimpleIcon, MinusSquareIcon } from '@phosphor-icons/react';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { files, type DocTreeItem } from '@platform/tauri/client';
import { openPath } from '@platform/tauri/opener';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { DROPDOWN_DIVIDER_SKIN } from '@shared/ui/dropdown-divider';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@shared/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import { useDocumentStore } from '@features/document/store';
import { useMemoStore } from '@features/memo';
import { canonicalPath } from '@/lib/path';
import { useAgentAccessStore } from '@features/agent/store/agent-access-store';
import { normalizeFilesDefaults } from '@/lib/agent-access-defaults';
import {
  flattenVisibleTree,
  useFolderTree,
  type VisibleTreeNode,
} from '@features/memo/components/use-folder-tree';
import { FileTypeIcon } from '@features/memo/components/file-type-icon';
import { useI18n } from '@/lib/i18n';
import { MemoNavigationDropdown } from '@features/memo/components/memo-navigation-dropdown';

const TREE_EDGE_GUTTER = 6;
const ITEM_INLINE_PADDING = 6;
const ITEM_ICON_SIZE = 16;
const INDENT_PER_LEVEL = 20;

/** 字节数 → 人类可读大小 (e.g. 36.6 KB)；末尾 0 去掉，folder 传 null 不显示。 */
function formatFileSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  const fmt = (v: number) => String(parseFloat(v.toFixed(2)));
  const kb = bytes / 1024;
  if (kb < 1024) return `${fmt(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${fmt(mb)} MB`;
  return `${fmt(mb / 1024)} GB`;
}

/** Unix epoch 毫秒 → "YYYY-MM-DD HH:mm" (本地时区)；null → "—"。 */
function formatTimestamp(ms: number | null): string {
  if (ms === null) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 资料文件夹文件树 (中间列) ── VSCode 风格。
 *
 * - 惰性展开: 后端单层列举, 展开 folder 时才拉子级 (`useFolderTree`)。
 * - 缩进: depth × 20px 外边距; 展开的 folder 子树沿父级图标中心显示
 *   竖向引导线。folder 默认显示 FolderSimple, hover 时原位替换成展开箭头。
 * - 交互: folder 行单击切展开; 所有文件单击后由第三列按类型处理:
 *   文本交给 CodeMirror, 图片直接预览, 其他文件显示无法查看。
 * - 右键菜单: 新建笔记 / 新建文件夹 (folder 上), 重命名, 删除, 复制
 *   路径, 在 Finder 显示。写操作走 `files.*` IPC, 成功后局部 `refresh`
 *   父目录。
 * - header 与 MemoList 同构高度 (Mac h-12 / Win h-9 由外层 titlebar
 *   组件负责), 这里只渲染标题行 + 树体。
 */
export function FolderFileTree({
  folderPath,
  folderName,
}: {
  folderPath: string;
  folderName: string;
}) {
  const { t } = useI18n();
  const tree = useFolderTree(folderPath);
  const [showScrollTopHint, setShowScrollTopHint] = useState(false);
  // 新建/重命名行的受控输入态: null = 无进行中的行内编辑。
  const [draftRow, setDraftRow] = useState<{ parentPath: string; kind: 'file' | 'folder'; value: string } | null>(null);
  const [renaming, setRenaming] = useState<{ item: DocTreeItem; value: string } | null>(null);
  // 「…」按钮下拉采用受控单开: 同一时刻只允许一个行菜单展开,
  // 点击其他按钮 / 其他位置时由 DropdownMenu 的 pointerdown 收起逻辑驱动 onOpenChange(false)。
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  const currentDocumentPath = useDocumentStore((s) => s.currentDocumentPath);
  const currentDocumentSource = useDocumentStore((s) => s.currentDocumentSource);
  const selectedNotebook = useMemoStore((s) => s.selectedNotebook);
  const setActiveFileBrowserPath = useMemoStore((s) => s.setActiveFileBrowserPath);
  const setActiveFileBrowserDocument = useMemoStore((s) => s.setActiveFileBrowserDocument);
  const setSelectedMemo = useMemoStore((s) => s.setSelectedMemo);
  const accessConfig = useAgentAccessStore((s) => s.config);
  const setDefaultFiles = useAgentAccessStore((s) => s.setDefaultFiles);
  const notebookId = selectedNotebook?.id;
  const defaultFiles = notebookId
    ? normalizeFilesDefaults(accessConfig.defaults?.files)[notebookId]
    : undefined;
  const folderPaths = defaultFiles?.folders ?? [];
  const workspace = defaultFiles?.workspace;
  const legacyFoldersFirst = workspace === undefined ? folderPaths[0] : undefined;
  const effectiveWorkspace =
    (workspace && folderPaths.includes(workspace) ? workspace : undefined) ??
    legacyFoldersFirst ??
    selectedNotebook?.path;
  const isCurrentFolderTracked = folderPaths.includes(folderPath);
  const isWorkspace = effectiveWorkspace === folderPath;
  // The persisted document may be nested below a collapsed folder. Once the
  // root has loaded, expand its parent chain so the restored selection is
  // actually visible in the tree.
  useEffect(() => {
    if (tree.loading || currentDocumentSource !== 'external' || !currentDocumentPath) return;
    void tree.expandTo(currentDocumentPath);
  }, [currentDocumentPath, currentDocumentSource, tree.expandTo, tree.loading]);

  // 滚动 / 缩放时收起「…」下拉 (对齐右键菜单的消失逻辑, DropdownMenu 自身不含此逻辑)。
  useEffect(() => {
    if (!openMenuId) return;
    const close = () => setOpenMenuId(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [openMenuId]);

  const visibleNodes = useMemo(() => flattenVisibleTree(tree), [tree]);

  const openDocument = useCallback((item: DocTreeItem) => {
    // 资料文档不是 memo。清掉 selectedMemo，避免重启时 memo 恢复逻辑
    // 抢先打开旧笔记；文档路径本身在 open 成功后写入持久化 store。
    setSelectedMemo(null);
    void useDocumentStore.getState()
      .openExternalDocument(item.fullPath, { scopePath: folderPath })
      .then(() => {
        setActiveFileBrowserDocument({ path: item.fullPath, scopePath: folderPath });
      })
      .catch(() => {
        // 文档切换失败时保留原来的持久化选择，避免下次启动恢复到
        // 实际没有打开成功的文件。
      });
  }, [folderPath, setActiveFileBrowserDocument, setSelectedMemo]);

  const handleDelete = useCallback(async (item: DocTreeItem) => {
    const ok = await files.delete(item.fullPath, folderPath);
    if (!ok) {
      toast.error(t('memo.fileTree.deleteFailed'));
      return;
    }
    const parent = item.fullPath.slice(0, item.fullPath.replace(/\/+$/, '').lastIndexOf('/'));
    await tree.refresh(parent || folderPath);
    toast.success(t('memo.fileTree.deleted', { name: item.name }));
  }, [folderPath, t, tree]);

  const handleRename = useCallback(async (item: DocTreeItem, nextName: string) => {
    const trimmed = nextName.trim();
    setRenaming(null);
    if (!trimmed || trimmed === item.name) return;
    // 后端没有 rename_file IPC; 走 read → write 新名 → delete 旧名。
    // 文件树场景文件普遍不大, 全量读写可接受。
    const targetPath = item.fullPath.slice(0, item.fullPath.lastIndexOf('/')) + '/' + trimmed;
    if (item.type === 'document') {
      const content = await files.read(item.fullPath, folderPath);
      if (content === null) {
        toast.error(t('memo.fileTree.renameFailed'));
        return;
      }
      const written = await files.write(targetPath, content, undefined, folderPath);
      if (!written) {
        toast.error(t('memo.fileTree.renameFailed'));
        return;
      }
      await files.delete(item.fullPath, folderPath);
    } else {
      // folder 重命名需要递归拷贝, 首版不支持 ── 提示走 Finder。
      toast.info(t('memo.fileTree.renameFolderUnsupported'));
      return;
    }
    const parent = item.fullPath.slice(0, item.fullPath.lastIndexOf('/'));
    await tree.refresh(parent || folderPath);
    toast.success(t('memo.fileTree.renamed', { name: trimmed }));
  }, [folderPath, t, tree]);

  const handleCreate = useCallback(async (parentPath: string, kind: 'file' | 'folder', name: string) => {
    const trimmed = name.trim();
    setDraftRow(null);
    if (!trimmed) return;
    const ok = kind === 'file'
      ? await files.createDocument(parentPath, trimmed) !== null
      : await files.createFolder(parentPath, trimmed) !== null;
    if (!ok) {
      toast.error(t('memo.fileTree.createFailed'));
      return;
    }
    await tree.refresh(parentPath);
  }, [t, tree]);

  const handleCopyPath = useCallback(async (item: DocTreeItem) => {
    try {
      await navigator.clipboard.writeText(item.fullPath);
      toast.success(t('memo.fileTree.pathCopied'));
    } catch {
      toast.error(t('memo.fileTree.copyFailed'));
    }
  }, [t]);

  const handleCopyFolderPath = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(folderPath);
      toast.success(t('memo.fileTree.pathCopied'));
    } catch {
      toast.error(t('memo.fileTree.copyFailed'));
    }
  }, [folderPath, t]);

  const handleSetWorkspace = useCallback(async () => {
    if (!notebookId || !isCurrentFolderTracked) return;
    const saved = await setDefaultFiles(notebookId, {
      workspace: folderPath,
      folders: folderPaths,
      notebooks: defaultFiles?.notebooks ?? [],
    });
    if (!saved) toast.error(t('agent.access.saveFailed'));
  }, [defaultFiles, folderPath, folderPaths, isCurrentFolderTracked, notebookId, setDefaultFiles, t]);

  const handleUnsetWorkspace = useCallback(async () => {
    if (!notebookId || !isCurrentFolderTracked) return;
    const saved = await setDefaultFiles(notebookId, {
      workspace: null,
      folders: folderPaths,
      notebooks: defaultFiles?.notebooks ?? [],
    });
    if (!saved) toast.error(t('agent.access.saveFailed'));
  }, [defaultFiles, folderPaths, isCurrentFolderTracked, notebookId, setDefaultFiles, t]);

  const handleRemoveFolder = useCallback(async () => {
    if (!notebookId || !isCurrentFolderTracked) return;
    const nextFolders = folderPaths.filter((path) => path !== folderPath);
    const saved = await setDefaultFiles(notebookId, {
      workspace: isWorkspace ? null : workspace ?? null,
      folders: nextFolders,
      notebooks: defaultFiles?.notebooks ?? [],
    });
    if (!saved) {
      toast.error(t('agent.access.saveFailed'));
      return;
    }
    toast.success(t('agent.access.folderDeleted', { name: folderName }));
    setActiveFileBrowserPath(null);
  }, [defaultFiles, folderName, folderPath, folderPaths, isCurrentFolderTracked, isWorkspace, notebookId, setActiveFileBrowserPath, setDefaultFiles, t, workspace]);

  const handleReveal = useCallback((item: DocTreeItem) => {
    void openPath(item.type === 'folder' ? item.fullPath : item.fullPath.slice(0, item.fullPath.lastIndexOf('/')));
  }, []);

  const closeLabel = tree.error ? t('memo.fileTree.unreadable') : folderName;

  // 保留每个 folder 的子树容器, 让收起也能从当前高度过渡到 0。
  // 子项仍由 nodes 缓存提供, 因此收起再展开不会重复请求已加载的目录。
  const renderTreeItems = (items: DocTreeItem[], depth: number): ReactNode[] => items.map((item) => {
    const isFolder = item.type === 'folder';
    const itemKey = canonicalPath(item.fullPath);
    const isExpanded = tree.expanded.has(itemKey);
    const children = isFolder ? (tree.nodes.get(itemKey)?.children ?? []) : [];
    const openable = !isFolder;
    const isActive = currentDocumentSource === 'external'
      && !!currentDocumentPath
      && canonicalPath(currentDocumentPath) === canonicalPath(item.fullPath);
    const isRenamingRow = renaming?.item.id === item.id;
    const creationParentPath = isFolder
      ? item.fullPath
      : item.fullPath.slice(0, item.fullPath.lastIndexOf('/')) || folderPath;

    return (
      <Fragment key={item.id}>
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              role={isFolder ? 'treeitem' : openable ? 'button' : undefined}
              aria-expanded={isFolder ? isExpanded : undefined}
              tabIndex={0}
              title={item.fullPath}
              onClick={() => (isFolder ? tree.toggle(item.fullPath) : openDocument(item))}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  if (isFolder) tree.toggle(item.fullPath);
                  else if (openable) openDocument(item);
                }
              }}
              className={cn(
                'folder-file-tree__item group relative flex h-7 items-center rounded-lg px-1.5 text-left text-sm font-normal leading-[1.6] text-[color-mix(in_oklch,var(--foreground)_95%,transparent)] transition-colors duration-150',
                isFolder || openable ? 'cursor-pointer' : 'cursor-default',
                isActive
                  ? 'bg-[var(--muted)]'
                  : 'hover:bg-[var(--muted)]',
              )}
              style={{
                marginLeft: TREE_EDGE_GUTTER + depth * INDENT_PER_LEVEL,
                width: `calc(100% - ${TREE_EDGE_GUTTER * 2 + depth * INDENT_PER_LEVEL}px)`,
              }}
            >
              {isRenamingRow ? (
                <>
                  {isFolder ? (
                    <FolderSimpleIcon className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
                  ) : (
                    <FileTypeIcon
                      path={item.name}
                      className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]"
                    />
                  )}
                  <input
                    autoFocus
                    value={renaming.value}
                    onChange={(event) => setRenaming({ item: renaming.item, value: event.target.value })}
                    onBlur={() => void handleRename(renaming.item, renaming.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void handleRename(renaming.item, renaming.value);
                      if (event.key === 'Escape') setRenaming(null);
                    }}
                    onClick={(event) => event.stopPropagation()}
                    className="ml-1.5 h-5 w-full min-w-0 border-0 bg-transparent px-0 text-sm font-normal text-[var(--foreground)] outline-none"
                  />
                </>
              ) : (
                <>
                  {isFolder ? (
                    <span className="relative h-4 w-4 shrink-0">
                      <CaretRightIcon
                        aria-hidden="true"
                        className={cn(
                          'absolute inset-0 m-auto h-3 w-3 text-[var(--muted-foreground)] opacity-0 transition-[opacity,transform] duration-150 group-hover:opacity-100 group-focus-visible:opacity-100',
                          isExpanded && 'rotate-90',
                        )}
                      />
                      <FolderSimpleIcon className="absolute inset-0 h-4 w-4 text-[var(--muted-foreground)] transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0" />
                    </span>
                  ) : (
                    <FileTypeIcon
                      path={item.name}
                      className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]"
                    />
                  )}
                  <span className="ml-1.5 min-w-0 flex-1 truncate">
                    {item.name}
                  </span>
                  {!isFolder && item.sizeBytes !== null && (
                    <span className="ml-2 mr-1 shrink-0 text-[11px] tabular-nums text-[color-mix(in_oklch,var(--muted-foreground)_50%,white)] [[data-theme='dark']_&]:opacity-50">
                      {formatFileSize(item.sizeBytes)}
                    </span>
                  )}
                  <DropdownMenu
                    open={openMenuId === item.id}
                    onOpenChange={(open) => setOpenMenuId(open ? item.id : null)}
                  >
                    <DropdownMenuTrigger
                      asChild
                      onClick={(event) => event.stopPropagation()}
                    >
                      <button
                        type="button"
                        aria-label={t('memo.fileTree.moreActions')}
                        title={t('memo.fileTree.moreActions')}
                        onMouseDown={(event) => event.stopPropagation()}
                        onPointerDown={(event) => event.stopPropagation()}
                        onKeyDown={(event) => event.stopPropagation()}
                        className="absolute right-1 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-md bg-[var(--muted)] text-[var(--muted-foreground)] opacity-0 transition-opacity hover:text-[var(--foreground)] group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100"
                      >
                        <MoreHorizontal aria-hidden="true" className="h-4 w-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" side="bottom" className="min-w-[188px] space-y-1 px-1 py-1.5">
                      <div className="select-text rounded-md px-2 py-1 text-[11px] leading-[1.6] text-[var(--muted-foreground)]">
                        <div className="flex items-center gap-0.5">
                          <span className="opacity-70">{t('memo.fileTree.createdAt')}</span>
                          <span className="tabular-nums">{formatTimestamp(item.createdMs)}</span>
                        </div>
                        <div className="flex items-center gap-0.5">
                          <span className="opacity-70">{t('memo.fileTree.updatedAt')}</span>
                          <span className="tabular-nums">{formatTimestamp(item.modifiedMs)}</span>
                        </div>
                      </div>
                      <hr className={cn('mx-2', DROPDOWN_DIVIDER_SKIN)} />
                      <DropdownMenuItem
                        onClick={() => setDraftRow({ parentPath: creationParentPath, kind: 'file', value: '' })}
                        className="gap-2 rounded-md px-2 hover:bg-[var(--muted)]"
                      >
                        {t('memo.fileTree.newDocument')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => setDraftRow({ parentPath: creationParentPath, kind: 'folder', value: '' })}
                        className="gap-2 rounded-md px-2 hover:bg-[var(--muted)]"
                      >
                        {t('memo.fileTree.newFolder')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => setRenaming({ item, value: item.name })}
                        className="gap-2 rounded-md px-2 hover:bg-[var(--muted)]"
                      >
                        {t('memo.fileTree.rename')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => void handleCopyPath(item)}
                        className="gap-2 rounded-md px-2 hover:bg-[var(--muted)]"
                      >
                        {t('memo.fileTree.copyPath')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => handleReveal(item)}
                        className="gap-2 rounded-md px-2 hover:bg-[var(--muted)]"
                      >
                        {t('memo.fileTree.reveal')}
                      </DropdownMenuItem>
                      <hr className={cn('mx-2', DROPDOWN_DIVIDER_SKIN)} />
                      <DropdownMenuItem
                        onClick={() => void handleDelete(item)}
                        className="gap-2 rounded-md px-2 hover:bg-[var(--muted)] hover:text-[var(--destructive)] focus:text-[var(--destructive)]"
                      >
                        {t('memo.fileTree.delete')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="min-w-[188px] space-y-1 px-1 py-1.5">
            <div className="select-text rounded-md px-2 py-1 text-[11px] leading-[1.6] text-[var(--muted-foreground)]">
              <div className="flex items-center gap-0.5">
                <span className="opacity-70">{t('memo.fileTree.createdAt')}</span>
                <span className="tabular-nums">{formatTimestamp(item.createdMs)}</span>
              </div>
              <div className="flex items-center gap-0.5">
                <span className="opacity-70">{t('memo.fileTree.updatedAt')}</span>
                <span className="tabular-nums">{formatTimestamp(item.modifiedMs)}</span>
              </div>
            </div>
            <hr className={cn('mx-2', DROPDOWN_DIVIDER_SKIN)} />
            <ContextMenuItem
              onClick={() => setDraftRow({ parentPath: creationParentPath, kind: 'file', value: '' })}
              className="gap-2 rounded-md px-2 hover:bg-[var(--muted)]"
            >
              {t('memo.fileTree.newDocument')}
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => setDraftRow({ parentPath: creationParentPath, kind: 'folder', value: '' })}
              className="gap-2 rounded-md px-2 hover:bg-[var(--muted)]"
            >
              {t('memo.fileTree.newFolder')}
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => setRenaming({ item, value: item.name })}
              className="gap-2 rounded-md px-2 hover:bg-[var(--muted)]"
            >
              {t('memo.fileTree.rename')}
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => void handleCopyPath(item)}
              className="gap-2 rounded-md px-2 hover:bg-[var(--muted)]"
            >
              {t('memo.fileTree.copyPath')}
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => handleReveal(item)}
              className="gap-2 rounded-md px-2 hover:bg-[var(--muted)]"
            >
              {t('memo.fileTree.reveal')}
            </ContextMenuItem>
            <hr className={cn('mx-2', DROPDOWN_DIVIDER_SKIN)} />
            <ContextMenuItem
              onClick={() => void handleDelete(item)}
              className="gap-2 rounded-md px-2 hover:bg-[var(--muted)] hover:text-[var(--destructive)] focus:text-[var(--destructive)]"
            >
              {t('memo.fileTree.delete')}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        {isFolder && (
          <div
            className="folder-file-tree__subtree"
            data-expanded={isExpanded}
            aria-hidden={!isExpanded}
            style={{
              '--folder-file-tree-guide-left': `${TREE_EDGE_GUTTER + depth * INDENT_PER_LEVEL + ITEM_INLINE_PADDING + ITEM_ICON_SIZE / 2}px`,
            } as CSSProperties}
          >
            <div className="folder-file-tree__subtree-inner">
              <div className="folder-file-tree__subtree-items">
                {renderTreeItems(children, depth + 1)}
              </div>
            </div>
          </div>
        )}
      </Fragment>
    );
  });

  return (
    <div className="relative flex h-full min-h-0 flex-col select-none bg-[var(--card)] text-[var(--foreground)]">
      {/* 标题行 ── 标题右侧下拉菜单用于在访达中显示当前资料文件夹。 */}
      <div className="flex items-center justify-between pl-2 pr-3.5 pb-2 gap-2">
        <div className="min-w-0 flex-1">
          <MemoNavigationDropdown
            title={closeLabel}
            titleTooltip={tree.error ? t('memo.fileTree.unreadable') : folderName}
            ariaLabel={t('memo.fileTree.navigationMenu')}
          >
            <div className="space-y-1">
              <DropdownMenuItem
                onClick={() => void handleCopyFolderPath()}
                className="cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
              >
                {t('memo.fileTree.copyPath')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => void openPath(folderPath)}
                className="cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
              >
                {t('memo.fileTree.reveal')}
              </DropdownMenuItem>
              {isCurrentFolderTracked && !isWorkspace && (
                <DropdownMenuItem
                  onClick={() => void handleSetWorkspace()}
                  className="cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
                >
                  {t('agent.access.contextSetWorkspace')}
                </DropdownMenuItem>
              )}
              {isCurrentFolderTracked && isWorkspace && (
                <DropdownMenuItem
                  onClick={() => void handleUnsetWorkspace()}
                  className="cursor-pointer rounded-md px-2 hover:bg-[var(--muted)]"
                >
                  {t('agent.access.contextUnsetWorkspace')}
                </DropdownMenuItem>
              )}
              {isCurrentFolderTracked && (
                <DropdownMenuItem
                  onClick={() => void handleRemoveFolder()}
                  className="cursor-pointer rounded-md px-2 hover:bg-[var(--muted)] hover:text-[var(--destructive)] focus:text-[var(--destructive)]"
                >
                  {t('agent.access.contextDelete')}
                </DropdownMenuItem>
              )}
            </div>
          </MemoNavigationDropdown>
        </div>
        <div className="flex items-center gap-0 shrink-0">
          <button
            type="button"
            aria-label={t('memo.fileTree.collapseAll')}
            title={t('memo.fileTree.collapseAll')}
            onClick={() => tree.collapseAll()}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
          >
            <MinusSquareIcon aria-hidden="true" size={14} weight="bold" />
          </button>
          <button
            type="button"
            aria-label={t('memo.fileTree.refresh')}
            title={t('memo.fileTree.refresh')}
            disabled={tree.loading}
            onClick={() => void tree.reload()}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:cursor-default disabled:opacity-50"
          >
            <ArrowClockwiseIcon aria-hidden="true" size={14} weight="bold" className={cn(tree.loading && 'animate-spin')} />
          </button>
          {tree.loading && (
            <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border border-[var(--muted-foreground)]/40 border-t-transparent" />
          )}
        </div>
      </div>
      {/* 与 AgentConversationList 同款分割线, 落在 root 文件夹标题与子级列表之间 */}
      <hr className={cn('mx-2', DROPDOWN_DIVIDER_SKIN)} />
      <div className="relative min-h-0 flex-1">
        <OverlayScrollbar
          className="h-full"
          scrollerClassName="h-full overflow-y-auto"
          onScroll={(event) => setShowScrollTopHint(event.currentTarget.scrollTop > 0)}
        >
          {visibleNodes.length === 0 && !tree.loading && (
            <div className="px-4 py-6 text-center text-xs text-[var(--muted-foreground)]">
              {tree.error ? t('memo.fileTree.unreadableHint') : t('memo.fileTree.empty')}
            </div>
          )}
          <div className="folder-file-tree__items">
            {renderTreeItems(tree.rootChildren, 0)}
            {/* 新建行 ── 跟在目标 folder 的子级之后。简化: 渲染在列表末尾,
                首版可接受 (VSCode 是原地插入)。 */}
            {draftRow && (
              <div
                className="folder-file-tree__item flex h-7 items-center pr-2"
                style={{
                  marginLeft: TREE_EDGE_GUTTER + (findDepth(visibleNodes, draftRow.parentPath) + 1) * INDENT_PER_LEVEL,
                }}
              >
                {draftRow.kind === 'folder' ? (
                  <FolderSimpleIcon className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
                ) : (
                  <FileTypeIcon
                    path={draftRow.value}
                    className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]"
                  />
                )}
                <input
                  autoFocus
                  value={draftRow.value}
                  placeholder={draftRow.kind === 'file' ? t('memo.fileTree.newNote') : t('memo.fileTree.newFolder')}
                  onChange={(event) => setDraftRow({ ...draftRow, value: event.target.value })}
                  onBlur={() => void handleCreate(draftRow.parentPath, draftRow.kind, draftRow.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void handleCreate(draftRow.parentPath, draftRow.kind, draftRow.value);
                    if (event.key === 'Escape') setDraftRow(null);
                  }}
                  className="ml-1.5 h-5 w-full min-w-0 border-0 bg-transparent px-0 text-sm font-normal text-[var(--foreground)] outline-none"
                />
              </div>
            )}
          </div>
        </OverlayScrollbar>
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute inset-x-0 top-0 z-[3] h-3 bg-gradient-to-b from-[color-mix(in_oklch,var(--foreground)_3%,transparent)] to-transparent transition-opacity duration-200',
            showScrollTopHint ? 'opacity-100' : 'opacity-0',
          )}
        />
      </div>
    </div>
  );
}

function findDepth(nodes: VisibleTreeNode[], parentPath: string): number {
  const canonicalParent = canonicalPath(parentPath).replace(/\/+$/, '');
  const hit = nodes.find(({ item }) => canonicalPath(item.fullPath) === canonicalParent);
  return hit?.depth ?? -1;
}
