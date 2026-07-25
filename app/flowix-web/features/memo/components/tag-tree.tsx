'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { HashIcon } from '@phosphor-icons/react';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@shared/ui/context-menu';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@shared/ui/dialog';
import { Button } from '@shared/ui/button';
import {
  useMemoLibraryMetadataStore,
  useMemoStore,
  useTagStore,
  type Notebook,
} from '@features/memo';
import {
  persistTagLayout,
  rebaseSelectedTagId,
  resolveSelectedTagId,
  type MemoTagLayoutItem,
  type MemoTagTreeItem,
} from '@features/memo/services/memo-list-metadata-service';
import { useI18n, type I18nParams } from '@features/i18n';
import { invalidateMentionTags } from '@features/editor/extensions/tag-mention';
import { useDragReorder, type DragDropTarget } from '@features/memo/hooks/use-drag-reorder';

type TagDropPosition = 'before' | 'after' | 'inside';

interface TagTreeProps {
  selectedNotebook: Notebook | null;
  /** loadTags 完成时上抛 (total/agent/todo) 计数, 供 NavFilterButtons 展示。 */
  onCountsChange: (counts: { total: number; agent: number; todo: number }) => void;
}

// 笔记本列表区域高度 ── 持久化键 + 读 / 写助手。
const TAG_COLLAPSED_STORAGE_PREFIX = 'flowix:tag-collapsed:';

function getCollapsedTagsStorageKey(notebookId: string): string {
  return `${TAG_COLLAPSED_STORAGE_PREFIX}${notebookId}`;
}

function readPersistedCollapsedTagIds(notebookId: string): string[] {
  try {
    const raw = localStorage.getItem(getCollapsedTagsStorageKey(notebookId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string')
      : [];
  } catch {
    return [];
  }
}

function writePersistedCollapsedTagIds(notebookId: string, ids: string[]): void {
  try {
    localStorage.setItem(getCollapsedTagsStorageKey(notebookId), JSON.stringify(ids));
  } catch {
    // 折叠状态是纯 UI 偏好, localStorage 不可用时不影响标签树本身。
  }
}

// 标签树 ── 从 NoteNavigationPanel 拆出。自持:
//   - loadTags effect (selectedNotebook 变化时拉 metadata, 上抛 counts)
//   - tag 状态 (tagOptions/tagLayout/hiddenTagIds/collapsedTagIds/编辑/删除)
//   - 拖拽重排 + reparent (useDragReorder, 替代原内联 tag 状态机)
//   - 行内重命名 / 右键删除确认弹窗 / drag ghost
// 与父级的唯一耦合是 onCountsChange (counts 上抛给 NavFilterButtons)。
export function TagTree({ selectedNotebook, onCountsChange }: TagTreeProps) {
  const { t } = useI18n();
  const activeFilter = useMemoStore((s) => s.activeFilter);
  const setActiveFilter = useMemoStore((s) => s.setActiveFilter);
  const selectedTagId = useTagStore((s) => s.selectedTagId);
  const setSelectedTagId = useTagStore((s) => s.setSelectedTagId);
  const tagMetadataRefreshVersion = useTagStore((s) => s.metadataRefreshVersion);
  const loadLibraryMetadata = useMemoLibraryMetadataStore((s) => s.loadMetadata);
  const clearLibraryMetadata = useMemoLibraryMetadataStore((s) => s.clearMetadata);

  const [tagOptions, setTagOptions] = useState<MemoTagTreeItem[]>([]);
  const [tagLayout, setTagLayout] = useState<MemoTagLayoutItem[]>([]);
  const [hiddenTagIds, setHiddenTagIds] = useState<string[]>([]);
  const [collapsedTagIds, setCollapsedTagIds] = useState<string[]>([]);
  // 行内重命名编辑态: editingTagId 命中时标签名 span 替换为 input。
  const [editingTagId, setEditingTagId] = useState<string | null>(null);
  const [editingTagName, setEditingTagName] = useState('');
  // 删除确认弹窗: `deletingTag` 命中时, 弹 Dialog 提示子树影响范围 + 确认。
  const [deletingTag, setDeletingTag] = useState<MemoTagTreeItem | null>(null);

  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const hiddenTagIdSet = useMemo(() => new Set(hiddenTagIds), [hiddenTagIds]);
  const collapsedTagIdSet = useMemo(() => new Set(collapsedTagIds), [collapsedTagIds]);
  const childTagIdSet = useMemo(() => {
    const ids = new Set<string>();
    for (const tag of tagOptions) {
      if (tag.parentId) ids.add(tag.parentId);
    }
    return ids;
  }, [tagOptions]);
  const visibleTagOptions = useMemo(() => {
    // 不过滤折叠子树, 而是全量渲染并标记 collapsedByAncestor;
    // 折叠的子树行留在 DOM 中, 由外层 .tag-collapse-track 的 grid 0fr/1fr
    // 过渡实现展开/折叠动画 (unmount 无法 CSS 过渡)。
    let collapsedDepth: number | null = null;
    return tagOptions.map((tag) => {
      const collapsedByAncestor = collapsedDepth !== null && tag.depth > collapsedDepth;
      if (collapsedDepth !== null && tag.depth <= collapsedDepth) {
        collapsedDepth = null;
      }
      if (collapsedTagIdSet.has(tag.id)) {
        collapsedDepth = tag.depth;
      }
      return { ...tag, collapsedByAncestor };
    });
  }, [collapsedTagIdSet, tagOptions]);

  useEffect(() => {
    let cancelled = false;

    const loadTags = async (notebook: Notebook) => {
      try {
        const metadata = await loadLibraryMetadata(
          notebook,
          tagMetadataRefreshVersion
        );
        if (!metadata || cancelled) return;
        setTagOptions(metadata.tagOptions);
        setTagLayout(metadata.tagLayout);
        setHiddenTagIds(metadata.hiddenTagIds);
        onCountsChange({
          total: metadata.totalMemoCount,
          agent: metadata.agentMemoCount,
          todo: metadata.todoMemoCount,
        });
        if (selectedNotebook) {
          const validTagIds = new Set(metadata.tagOptions.map((tag) => tag.id));
          const nextCollapsed = readPersistedCollapsedTagIds(selectedNotebook.id)
            .filter((id) => validTagIds.has(id));
          setCollapsedTagIds(nextCollapsed);
        }
        // 用当前 selectedTagId 重新校验 (而非 IPC 时的旧值): IPC 期间
        // selectedTagId 可能已变 (重命名 commitRename 把旧路径更新到新
        // fullPath), 用旧值校验出的 null 会覆盖新值, 选中态丢成"全部"。
        const currentSelectedTagId = useTagStore.getState().selectedTagId;
        const resolvedSelectedTagId = resolveSelectedTagId(currentSelectedTagId, metadata.tagOptions);
        if (resolvedSelectedTagId !== currentSelectedTagId) {
          setSelectedTagId(resolvedSelectedTagId);
        }
      } catch (error) {
        if (!cancelled) {
          console.warn('[TagTree] Failed to load tags:', error);
          setTagOptions([]);
          setTagLayout([]);
          setHiddenTagIds([]);
          setCollapsedTagIds([]);
          onCountsChange({ total: 0, agent: 0, todo: 0 });
        }
      }
    };

    if (!selectedNotebook) {
      setTagOptions([]);
      setTagLayout([]);
      setHiddenTagIds([]);
      setCollapsedTagIds([]);
      onCountsChange({ total: 0, agent: 0, todo: 0 });
      clearLibraryMetadata();
      return;
    }

    void loadTags(selectedNotebook);

    return () => {
      cancelled = true;
    };
  }, [clearLibraryMetadata, loadLibraryMetadata, tagMetadataRefreshVersion, selectedNotebook, setSelectedTagId, onCountsChange]);

  const handleTagSelect = useCallback(
    (tagId: string) => {
      setSelectedTagId(tagId);
      setActiveFilter('tagged');
    },
    [
      setActiveFilter,
      setSelectedTagId,
    ],
  );

  const startRename = useCallback((tag: MemoTagTreeItem) => {
    setEditingTagId(tag.id);
    setEditingTagName(tag.name);
  }, []);

  // 行内重命名提交: 复用 moveTag (重命名 = 同父级 move 末段)。segment 字符
  // 类与 TAG_REGEX [^/\s\p{P}]+ 一致; 冲突依赖后端 AlreadyExists 报错 toast,
  // 保持编辑态。成功后失效 mention 缓存 + 清 metadata, 并把 selectedTagId
  // 跟到新 fullPath (否则 metadata refresh 会用 validTagSelectionSet 校验掉
  // 旧路径, 丢失选中态)。
  const commitRename = useCallback(
    async (tag: MemoTagTreeItem, newSegment: string) => {
      const trimmed = newSegment.trim();
      if (!trimmed || trimmed === tag.name) {
        setEditingTagId(null);
        return;
      }
      if (/[/\s\p{P}]/u.test(trimmed)) {
        toast.error(t('memo.tag.renameInvalidChar'));
        return;
      }
      const lastSlash = tag.fullPath.lastIndexOf('/');
      const parent = lastSlash > 0 ? tag.fullPath.slice(0, lastSlash) : null;
      const newFullPath = parent ? `${parent}/${trimmed}` : trimmed;
      if (newFullPath === tag.fullPath) {
        setEditingTagId(null);
        return;
      }
      const notebookId = useMemoStore.getState().selectedNotebook?.id;
      if (!notebookId) {
        setEditingTagId(null);
        return;
      }
      // moveTag 前记下选中态 ── 不能在 await 后取: moveTag 期间后端 emit
      // MemoEvent::Updated 触发 metadata 重载, 会把旧路径 selectedTagId
      // 校验清成 null, await 后取到的已是 null, 无法前缀替换。
      const beforeSelected = useTagStore.getState().selectedTagId;
      try {
        const report = await useTagStore
          .getState()
          .moveTag(notebookId, tag.fullPath, newFullPath);
        if (report) {
          // 选中态保持: 把 selectedTagId 从旧前缀映射到新前缀 (本身 / 后代),
          // 在 clearLibraryMetadata 前同步写回, 不依赖 await 后的 selectedTagId。
          const nextSelected = rebaseSelectedTagId(beforeSelected, tag.fullPath, newFullPath);
          if (nextSelected !== useTagStore.getState().selectedTagId) {
            useTagStore.getState().setSelectedTagId(nextSelected);
          }
          clearLibraryMetadata();
          invalidateMentionTags();
        }
        setEditingTagId(null);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    },
    [clearLibraryMetadata, t],
  );

  /**
   * 提交删除一个 tag 子树。 与 `commitRename` 对称 ── 但语义不同:
   * rename 是改写 token, delete 是移除 token。 删除的影响范围**可能**跨
   * 多级 (子节点也会被一并删), 所以先经 Dialog 确认, 用户明确点确认才
   * 真正调 IPC。
   *
   * 选中态处理: 如果 selectedTagId 命中被删子树 (是 tag 自身或其后代),
   * 一律 `setSelectedTagId(null)` + 切 `activeFilter='all'` ── 被删的 tag
   * 已经不存在了, 旧选中态没意义。 这与 rename 的 rebaseSelectedTagId
   * (跟到新 fullPath) 形成对照。
   *
   * 后端 `delete_memo_tag` IPC 同步完成后会 emit `MemoEvent::TagsDeleted`,
   * frontend handler 走 `handleTagsDeleted` 局部 patch memos[*].tags。
   */
  const confirmDeleteTag = useCallback(
    async (tag: MemoTagTreeItem) => {
      const notebookId = useMemoStore.getState().selectedNotebook?.id;
      if (!notebookId) return;
      // 记下删除前的 selectedTagId ── 同 commitRename 的 beforeSelected
      // 模式: IPC 期间 memo-event 触发 metadata 重载, 旧 selectedTagId
      // 会被 validate 掉成 null, await 后取不到原值。
      const beforeSelected = useTagStore.getState().selectedTagId;
      // 计算受影响的下游:
      // - selectedTagId 命中子树 -> 重置为 null + 切 activeFilter='all'
      // - 命中但不在子树的 (前/同级) -> 保留不动
      const selectedInsideSubtree =
        beforeSelected !== null &&
        (beforeSelected === tag.fullPath ||
          beforeSelected.startsWith(`${tag.fullPath}/`));
      try {
        const report = await useTagStore.getState().deleteTag(notebookId, tag.fullPath);
        if (report) {
          if (selectedInsideSubtree) {
            // 选中态失效: selectedTagId 校验会立刻清成 null (validate
            // 失败), 我们主动先写回 null 避免 useEffect 异步路径里出现
            // 一次 "无效值" 闪烁。 activeFilter 切 'all' 让列表回到
            // 未筛选状态。
            setSelectedTagId(null);
            setActiveFilter('all');
          }
          clearLibraryMetadata();
          invalidateMentionTags();
          toast.success(t('memo.tag.deletedToast', { path: tag.fullPath } satisfies I18nParams));
        }
      } catch (err) {
        toast.error(
          `${t('memo.tag.deleteFailed')}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [clearLibraryMetadata, setActiveFilter, setSelectedTagId, t],
  );

  const handleTagCollapseToggle = useCallback((tagId: string) => {
    const notebookId = useMemoStore.getState().selectedNotebook?.id;
    setCollapsedTagIds((current) => {
      const next = current.includes(tagId)
        ? current.filter((id) => id !== tagId)
        : [...current, tagId];
      if (notebookId) {
        writePersistedCollapsedTagIds(notebookId, next);
      }
      return next;
    });
  }, []);

  const rebuildTagOptionsFromLayout = useCallback(
    (layout: MemoTagLayoutItem[]): MemoTagTreeItem[] => {
      // Step 3+ 本地版: 跟 [memo-list-metadata-service] 的 buildTagTreeOptions
      // 同源 ── 路径拆 segment、同 fullPath 合并、parent 由字面推导。
      // 输入 `layout` 是真实 tag fullPath 列表 (用户拖拽后产生的新顺序),
      // 输出是 segment 节点树, 用于立刻重渲染面板 (不重新触发 IPC)。
      const segmentByFullPath = new Map<
        string,
        { name: string; fullPath: string; depth: number; count: number }
      >();

      // count 复用当前 tagOptions, 避免重算 prefix; 但 segmentByFullPath 不预填:
      // 必须按 layout 顺序 ensureSegment, 否则 layout 顺序被忽略, 拖动后 UI 不变
      // (要等 reload 走 buildTagTreeOptions 才生效)。
      const countByFullPath = new Map(tagOptions.map((seg) => [seg.fullPath, seg.count]));

      const ensureSegment = (fullPath: string) => {
        if (segmentByFullPath.has(fullPath)) return;
        const lastSlash = fullPath.lastIndexOf('/');
        if (lastSlash > 0) {
          ensureSegment(fullPath.slice(0, lastSlash));
        }
        const name = lastSlash > 0 ? fullPath.slice(lastSlash + 1) : fullPath;
        const depthFromSlashes = (fullPath.match(/\//g) ?? []).length;
        segmentByFullPath.set(fullPath, {
          name,
          fullPath,
          depth: depthFromSlashes,
          count: countByFullPath.get(fullPath) ?? 0,
        });
      };

      // 按 layout 顺序展开: segment 节点顺序 = layout 顺序 (同级 reorder 立即生效)。
      for (const item of layout) {
        ensureSegment(item.id);
      }

      const childrenByParent = new Map<string | null, string[]>();
      for (const fullPath of segmentByFullPath.keys()) {
        const lastSlash = fullPath.lastIndexOf('/');
        const parentFullPath = lastSlash > 0 ? fullPath.slice(0, lastSlash) : null;
        const arr = childrenByParent.get(parentFullPath) ?? [];
        arr.push(fullPath);
        childrenByParent.set(parentFullPath, arr);
      }

      const result: MemoTagTreeItem[] = [];
      const visit = (fullPath: string) => {
        const seg = segmentByFullPath.get(fullPath)!;
        const lastSlash = fullPath.lastIndexOf('/');
        const parentFullPath = lastSlash > 0 ? fullPath.slice(0, lastSlash) : null;
        result.push({
          id: fullPath,
          parentId: parentFullPath,
          name: seg.name,
          fullPath,
          depth: seg.depth,
          count: seg.count,
        });
        for (const child of childrenByParent.get(fullPath) ?? []) {
          visit(child);
        }
      };

      for (const root of childrenByParent.get(null) ?? []) {
        visit(root);
      }
      return result;
    },
    [tagOptions]
  );

  const getSubtreeIds = useCallback(
    (sourceId: string): string[] => {
      const sourceIndex = tagOptions.findIndex((tag) => tag.id === sourceId);
      if (sourceIndex < 0) return [];
      const sourceDepth = tagOptions[sourceIndex].depth;
      const ids = [sourceId];
      for (let index = sourceIndex + 1; index < tagOptions.length; index += 1) {
        if (tagOptions[index].depth <= sourceDepth) break;
        ids.push(tagOptions[index].id);
      }
      return ids;
    },
    [tagOptions]
  );

  // 拖动排序 / 层级逻辑:
  // 1. pointerdown 在行上设 setPointerCapture 并暂存起点;
  // 2. pointermove 越过 4px 阈值进入拖动态, 显示 ghost + drop 指示;
  // 3. pointerup 时若处于拖动态则提交 reorder, 否则回退为选中点击;
  // 4. before/after 调整同级顺序 (纯 UI 排序, 写 tagLayout 持久化);
  //    inside 走 Step 3 的 `move_memo_tag` IPC, 改写 source 整棵子树
  //    的 name + 批量改 body。
  const applyTagMove = useCallback(
    async (sourceId: string, targetId: string, position: TagDropPosition) => {
      if (sourceId === targetId) return;
      const sourceSubtreeIds = getSubtreeIds(sourceId);
      if (sourceSubtreeIds.length === 0 || sourceSubtreeIds.includes(targetId)) return;

      const target = tagOptions.find((tag) => tag.id === targetId);
      if (!target) return;

      const sourceTag = tagOptions.find((tag) => tag.id === sourceId);
      if (!sourceTag) return;

      const notebookId = useMemoStore.getState().selectedNotebook?.id;
      if (!notebookId) return;

      // **inside**: 真正的 reparent ── 通过 `move_memo_tag` IPC 把
      // source 整棵子树 (含 source.fullPath 自身 + 所有 source.fullPath/*
      // 子孙) 重命名为 `target.fullPath + '/' + source.name`。
      // 节点是 segment 节点, name 是末段, fullPath 是完整路径, 两
      // 者拼接成新 fullPath 给后端。后端会批量改写所有受影响 memo
      // 的 YAML `tags`, 同步 memo index。
      if (position === 'inside') {
        const newPath = `${target.fullPath}/${sourceTag.name}`;

        // 展开 target (让用户看到子树整体移动)
        setCollapsedTagIds((current) => {
          if (!current.includes(targetId)) return current;
          const next = current.filter((id) => id !== targetId);
          writePersistedCollapsedTagIds(notebookId, next);
          return next;
        });

        // moveTag 前记下选中态 ── await 期间 memo-event 触发的 metadata 重载
        // 会把旧路径 selectedTagId 校验清成 null, await 后取不到原值。
        const beforeSelected = useTagStore.getState().selectedTagId;
        try {
          const report = await useTagStore
            .getState()
            .moveTag(notebookId, sourceTag.fullPath, newPath);
          if (report) {
            // 选中态保持: 把 selectedTagId 从旧前缀映射到新前缀, 在
            // clearLibraryMetadata 前同步写回, 不依赖 await 后的 selectedTagId。
            const nextSelected = rebaseSelectedTagId(beforeSelected, sourceTag.fullPath, newPath);
            if (nextSelected !== useTagStore.getState().selectedTagId) {
              useTagStore.getState().setSelectedTagId(nextSelected);
            }
            // 编辑器 `#` mention 缓存失效 + metadata 重拉 (列表/面板/下拉)。
            clearLibraryMetadata();
            invalidateMentionTags();
          }
        } catch (err) {
          // 失败: 给出可见错误提示, 不改变 UI 状态 (memo index 没动)
          console.warn(
            `[TagTree] move tag "${sourceTag.fullPath}" -> "${newPath}" failed:`,
            err,
          );
          toast.error(
            err instanceof Error ? err.message : String(err),
          );
        }
        return;
      }

      // **before / after**: 纯 UI 排序, 持久化到 tagLayout。
      const currentLayout = tagLayout.length > 0
        ? tagLayout
        : tagOptions.map(({ id, parentId }) => ({ id, parentId }));
      const movingItems = currentLayout.filter((item) => sourceSubtreeIds.includes(item.id));
      const remaining = currentLayout.filter((item) => !sourceSubtreeIds.includes(item.id));
      const nextMovingItems = movingItems;

      let insertIndex = remaining.length;
      const targetIndex = remaining.findIndex((item) => item.id === targetId);
      if (targetIndex < 0) return;
      if (position === 'before') {
        insertIndex = targetIndex;
      } else {
        const targetSubtreeIds = getSubtreeIds(targetId).filter((id) => !sourceSubtreeIds.includes(id));
        const lastTargetSubtreeId = targetSubtreeIds[targetSubtreeIds.length - 1] ?? targetId;
        insertIndex = remaining.findIndex((item) => item.id === lastTargetSubtreeId) + 1;
      }

      const nextLayout = [
        ...remaining.slice(0, insertIndex),
        ...nextMovingItems,
        ...remaining.slice(insertIndex),
      ];

      setTagLayout(nextLayout);
      setTagOptions(rebuildTagOptionsFromLayout(nextLayout));
      void persistTagLayout(nextLayout, notebookId).catch((error) => {
        console.warn('[TagTree] Failed to persist tag layout:', error);
      });
      clearLibraryMetadata();
      invalidateMentionTags();
    },
    [clearLibraryMetadata, getSubtreeIds, rebuildTagOptionsFromLayout, tagLayout, tagOptions]
  );

  const findDropTarget = useCallback(
    (y: number, sourceId: string): DragDropTarget<TagDropPosition> | null => {
      const sourceSubtreeIds = getSubtreeIds(sourceId);
      for (const tag of visibleTagOptions) {
        if (tag.collapsedByAncestor) continue;
        if (sourceSubtreeIds.includes(tag.id)) continue;
        const row = rowRefs.current.get(tag.id);
        if (!row) continue;
        const rect = row.getBoundingClientRect();
        if (y >= rect.top && y <= rect.bottom) {
          const relativeY = y - rect.top;
          const position: TagDropPosition =
            relativeY < rect.height / 3
              ? 'before'
              : relativeY > (rect.height * 2) / 3
                ? 'after'
                : 'inside';
          return { id: tag.id, position };
        }
      }
      return null;
    },
    [getSubtreeIds, visibleTagOptions]
  );

  const { draggingId, dropTarget, dragGhost, handlePointerDown } = useDragReorder<TagDropPosition>({
    findDropTarget,
    applyMove: applyTagMove,
    onSelect: handleTagSelect,
  });

  const draggingTagId = draggingId;

  return (
    <>
      {/* 标签组 ── 外侧容器, pt-1 提供组上方留白 (与资料组对称, 两侧均用 padding 而非 margin); space-y-0.5 维持标签行 2px 间距。 */}
      <div className="space-y-0.5 pt-1">
        {/* 标签分类标题 ── 过滤器 (全部/对话/待办) 在上, 真正的标签树在此标题之下。 */}
        <div
          className="agent-thread-card__access-section-label"
        >
          {t('memo.navigation.tags')}
        </div>
        {tagOptions.length > 0 && (
          <>
          {visibleTagOptions.map((tag) => {
            const isSelected = activeFilter === 'tagged' && selectedTagId === tag.id;
            const isHidden = hiddenTagIdSet.has(tag.id);
            const isDragging = draggingTagId === tag.id;
            const hasChildren = childTagIdSet.has(tag.id);
            const isDropBefore =
              dropTarget?.id === tag.id && dropTarget.position === 'before' && !isDragging;
            const isDropAfter =
              dropTarget?.id === tag.id && dropTarget.position === 'after' && !isDragging;
            const isDropInside =
              dropTarget?.id === tag.id && dropTarget.position === 'inside' && !isDragging;

            return (
              <div
                key={tag.id}
                className="tag-collapse-track"
                data-collapsed={tag.collapsedByAncestor || undefined}
                aria-hidden={tag.collapsedByAncestor || undefined}
              >
              <ContextMenu>
              <ContextMenuTrigger asChild>
              <div
                ref={(node) => {
                  if (node) {
                    rowRefs.current.set(tag.id, node);
                  } else {
                    rowRefs.current.delete(tag.id);
                  }
                }}
                role="button"
                tabIndex={tag.collapsedByAncestor ? -1 : 0}
                onPointerDown={(event) => handlePointerDown(event, tag.id)}
                onDoubleClick={(event) => {
                  if (!hasChildren) return;
                  event.preventDefault();
                  handleTagCollapseToggle(tag.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    handleTagSelect(tag.id);
                  }
                }}
                className={cn(
                  'group relative flex h-8 w-full cursor-pointer select-none items-center gap-0 rounded-md pr-2 text-left text-sm transition-colors',
                  isSelected
                    ? 'bg-[var(--muted)] text-[var(--foreground)]'
                    : 'text-[var(--foreground)] hover:bg-[var(--muted)]',
                  isDragging && 'opacity-50',
                  isDropInside && 'tag-drop-target-inside',
                  isHidden && !isSelected && 'opacity-70',
                )}
                style={{ paddingLeft: `${6 + tag.depth * 14}px` }}
                title={tag.fullPath}
                aria-pressed={isSelected}
              >
                <span
                  data-tag-icon=""
                  className={cn(
                    'relative inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center -ml-1 mr-1 opacity-90',
                    hasChildren && 'cursor-pointer',
                  )}
                  // `#` 图标当作独立控件: 单击展开/折叠, 不触发行
                  // 选中也不进入拖拽。键盘 Enter/Space 同样可用。
                  // hover/focus 时 [data-tag-icon]:hover 规则加深展开三角
                  // ── 视觉提示该图标可点击。
                  role={hasChildren ? 'button' : undefined}
                  tabIndex={hasChildren ? 0 : undefined}
                  aria-label={
                    hasChildren
                      ? collapsedTagIdSet.has(tag.id)
                        ? t('memo.tag.expand')
                        : t('memo.tag.collapse')
                      : undefined
                  }
                  onPointerDown={(event) => {
                    // 阻止事件冒泡到行 ── 避免在图标上按下也启动 drag
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    if (!hasChildren) return;
                    event.stopPropagation();
                    event.preventDefault();
                    handleTagCollapseToggle(tag.id);
                  }}
                  onKeyDown={(event) => {
                    if (!hasChildren) return;
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.stopPropagation();
                      event.preventDefault();
                      handleTagCollapseToggle(tag.id);
                    }
                  }}
                >
                  <HashIcon
                    className="h-3.5 w-3.5 text-[var(--muted-foreground)]"
                    weight="bold"
                  />
                  {hasChildren && (
                    <span
                      aria-hidden
                      className="tag-expand-indicator pointer-events-none absolute bottom-[3px] right-[3px] h-0 w-0 border-b-[5px] border-l-[5px] border-l-transparent"
                    />
                  )}
                </span>
                {editingTagId === tag.id ? (
                  <input
                    autoFocus
                    value={editingTagName}
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => setEditingTagName(e.target.value)}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void commitRename(tag, editingTagName);
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setEditingTagId(null);
                      }
                    }}
                    onBlur={() => void commitRename(tag, editingTagName)}
                    className="min-w-0 flex-1 rounded-md bg-[var(--background)] px-0 text-sm outline-none ring-1 ring-[var(--primary)]"
                  />
                ) : (
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate',
                      isHidden && !isSelected && 'text-[var(--muted-foreground)]',
                    )}
                  >
                    {tag.name}
                  </span>
                )}
                <span
                  className={cn(
                    'ml-2 shrink-0 tabular-nums text-xs text-[var(--muted-foreground)]',
                    isSelected && 'text-[var(--foreground)]/70',
                  )}
                >
                  {tag.count}
                </span>
                {isDropBefore && (
                  <span className="pointer-events-none absolute inset-x-1 top-0 h-0.5 rounded-full bg-[var(--brand)]" />
                )}
                {isDropAfter && (
                  <span className="pointer-events-none absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-[var(--brand)]" />
                )}
              </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-[160px]">
                <ContextMenuItem onClick={() => startRename(tag)}>
                  {t('memo.tag.rename')}
                </ContextMenuItem>
                <ContextMenuItem
                  onClick={() => setDeletingTag(tag)}
                  className="hover:text-[var(--destructive)] focus:text-[var(--destructive)] hover:bg-[var(--destructive)]/10 focus:bg-[var(--destructive)]/10"
                >
                  {t('memo.tag.delete')}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
              </div>
            );
          })}
          </>
        )}
      </div>

      {/* Tag 删除确认弹窗 ── 右键菜单"删除" 触发。 子树命中时给出更
          严肃的提示文案, 明确告诉用户删除是整棵子树 + body 里所有
          #tag 都会被移除, 无法撤销。 */}
      <Dialog
        open={deletingTag !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingTag(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('memo.tag.deleteConfirmTitle')}</DialogTitle>
            <DialogDescription>
              {(() => {
                const target = deletingTag;
                if (!target) return '';
                // 子孙节点数 (含自身=1 之外的层级, 即 tag.<...>) ── 用
                // tagOptions 派生, 不走后端 IPC。 子树命中 0 个就显示
                // "leaf" 文案, 1+ 个就显示 "withChildren" 文案。
                const subtreeCount = tagOptions.filter(
                  (opt) =>
                    opt.fullPath !== target.fullPath &&
                    opt.fullPath.startsWith(`${target.fullPath}/`),
                ).length;
                if (subtreeCount === 0) {
                  return t('memo.tag.deleteConfirmLeaf', { path: target.fullPath } satisfies I18nParams);
                }
                return t('memo.tag.deleteConfirmWithChildren', {
                  path: target.fullPath,
                  count: subtreeCount,
                } satisfies I18nParams);
              })()}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => setDeletingTag(null)}
            >
              {t('memo.tag.deleteCancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const target = deletingTag;
                if (!target) return;
                setDeletingTag(null);
                void confirmDeleteTag(target);
              }}
            >
              {t('memo.tag.deleteConfirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {dragGhost && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[1100] flex items-center gap-2 rounded-md border border-[var(--primary)] bg-[var(--card)] px-2 text-sm opacity-50 shadow-lg"
          style={{
            left: dragGhost.currentX + 12,
            top: dragGhost.currentY + 12,
            width: dragGhost.rect.width,
            height: dragGhost.rect.height,
          }}
        >
          <HashIcon
            className="h-3.5 w-3.5 shrink-0 text-[var(--primary)]"
            weight="bold"
          />
          <span className="min-w-0 flex-1 truncate">
            {tagOptions.find((tag) => tag.id === dragGhost.id)?.name ?? ''}
          </span>
        </div>
      )}
    </>
  );
}
