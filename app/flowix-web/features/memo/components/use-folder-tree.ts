'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { files, type DocTreeItem } from '@platform/tauri/client';
import { canonicalPath } from '@/lib/path';
import { createLogger } from '@/lib/logger';

const logger = createLogger('folder-tree');

/**
 * VSCode 风格文件树数据 hook ── 惰性单层加载。
 *
 * 后端 `get_file_tree` / `get_dir_children` 只列直接子项 (folder 的
 * children 是空占位), 这里维护两层状态:
 *   - nodes: path → DocTreeItem (扁平 node 表, 渲染时按 expanded 集合
 *     从根出发走 children 递归拍平)
 *   - expanded: 已展开的 folder path 集合 (Set<string>, canonical 化)
 *
 * 展开一个 folder 时才对它调 `getDirChildren`, 结果 merge 进 nodes;
 * 收起再展开不重新拉 (VSCode 同款行为), 刷新走 `refresh(dirPath)`。
 *
 * 帧率保护: 同一目录的并发请求只保留最后一次 (seq 计数), 组件卸载后
 * 的迟到响应直接丢弃。
 */
export interface FolderTreeState {
  /** 根目录直接子项 (有序)。 */
  rootChildren: DocTreeItem[];
  /** path (canonical) → node。含根下所有已加载节点。 */
  nodes: Map<string, DocTreeItem>;
  /** 已展开的 folder path 集合。 */
  expanded: Set<string>;
  loading: boolean;
  /** 根目录读取失败 (路径被删 / 无权限) 时为错误信息。 */
  error: string | null;
}

export function useFolderTree(folderPath: string) {
  const [rootChildren, setRootChildren] = useState<DocTreeItem[]>([]);
  const [nodes, setNodes] = useState<Map<string, DocTreeItem>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 请求代际: 每次 folderPath 变化 / 手动刷新自增, 迟到响应按代丢弃。
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadRoot = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    try {
      const items = await files.getTree(folderPath);
      if (!mountedRef.current || generation !== generationRef.current) return;
      if (items === null) {
        setRootChildren([]);
        setNodes(new Map());
        setExpanded(new Set());
        setError('unreadable');
        return;
      }
      const next = new Map<string, DocTreeItem>();
      for (const item of items) next.set(canonicalPath(item.fullPath), item);
      setRootChildren(items);
      setNodes(next);
      // 根目录变了, 展开状态整体作废 (旧 path 不可能出现在新根下)。
      setExpanded(new Set());
    } catch (err) {
      logger.warn('load root failed', { folderPath, err });
      if (!mountedRef.current || generation !== generationRef.current) return;
      setError('unreadable');
    } finally {
      if (mountedRef.current && generation === generationRef.current) {
        setLoading(false);
      }
    }
  }, [folderPath]);

  useEffect(() => {
    void loadRoot();
  }, [loadRoot]);

  /** 展开时惰性拉子级; 已有子级的 folder 只切展开态。 */
  const loadChildren = useCallback(async (dirPath: string) => {
    const key = canonicalPath(dirPath);
    const existing = nodes.get(key);
    // children 非空 (或是首层已知的非空列表) 说明已加载过。root 的
    // children 为空数组且确实是空目录时, 每次展开都会重新请求一次,
    // 但空目录请求成本极低, 且能在外部新建文件后自动补上。
    if (existing?.children && existing.children.length > 0) return;
    const generation = generationRef.current;
    try {
      const children = await files.getDirChildren(dirPath);
      if (!mountedRef.current || generation !== generationRef.current) return;
      setNodes((prev) => {
        const next = new Map(prev);
        for (const child of children) {
          next.set(canonicalPath(child.fullPath), child);
        }
        // 回写父节点 children 占位 (flattenVisibleTree 按它递归拍平)。
        const parent = next.get(key);
        if (parent) next.set(key, { ...parent, children });
        return next;
      });
    } catch (err) {
      logger.warn('load children failed', { dirPath, err });
    }
  }, [nodes]);

  const toggle = useCallback((dirPath: string) => {
    const key = canonicalPath(dirPath);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
    void loadChildren(dirPath);
  }, [loadChildren]);

  /** 折叠所有已展开的 folder ── 清空 expanded 集合。 */
  const collapseAll = useCallback(() => {
    setExpanded(new Set());
  }, []);

  /** 展开到指定 path (打开文件后定位用, 逐级展开父链)。 */
  const expandTo = useCallback((targetPath: string) => {
    // 逐级展开 target 的所有祖先 (后端 parentId 恒 None, 用路径前缀推导)。
    // target 自身是文件时不入集合, 只展开它的目录前缀。
    const canonicalTarget = canonicalPath(targetPath);
    const sepIndex = canonicalTarget.lastIndexOf('/');
    if (sepIndex <= 0) return;
    const ancestors: string[] = [];
    let cursor = canonicalTarget.slice(0, sepIndex);
    while (cursor.length > 1) {
      ancestors.push(cursor);
      const next = cursor.slice(0, cursor.lastIndexOf('/'));
      if (next.length < 1) break;
      cursor = next;
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const p of ancestors) next.add(p);
      return next;
    });
  }, []);

  /** 局部刷新某个目录的子级 (新建/删除/重命名后调用)。 */
  const refresh = useCallback(async (dirPath?: string) => {
    const generation = generationRef.current;
    try {
      if (dirPath && dirPath !== folderPath) {
        const children = await files.getDirChildren(dirPath);
        if (!mountedRef.current || generation !== generationRef.current) return;
        const key = canonicalPath(dirPath);
        setNodes((prev) => {
          const next = new Map(prev);
          for (const child of children) {
            next.set(canonicalPath(child.fullPath), child);
          }
          // 局部刷新同样回写父节点 children 占位。
          const parent = next.get(key);
          if (parent) next.set(key, { ...parent, children });
          return next;
        });
        return;
      }
      await loadRoot();
    } catch (err) {
      logger.warn('refresh failed', { dirPath, err });
    }
  }, [folderPath, loadRoot]);

  const state: FolderTreeState = useMemo(
    () => ({ rootChildren, nodes, expanded, loading, error }),
    [rootChildren, nodes, expanded, loading, error],
  );

  return { ...state, toggle, expandTo, collapseAll, refresh, reload: loadRoot };
}

/** 渲染辅助 ── 从 rootChildren + nodes + expanded 拍平整棵可见树。 */
export interface VisibleTreeNode {
  item: DocTreeItem;
  depth: number;
}

export function flattenVisibleTree(state: FolderTreeState): VisibleTreeNode[] {
  const out: VisibleTreeNode[] = [];
  const walk = (items: DocTreeItem[], depth: number) => {
    for (const item of items) {
      out.push({ item, depth });
      if (item.type !== 'folder') continue;
      const key = canonicalPath(item.fullPath);
      if (!state.expanded.has(key)) continue;
      const node = state.nodes.get(key);
      const children = node?.children;
      if (children && children.length > 0) {
        walk(children, depth + 1);
      }
    }
  };
  walk(state.rootChildren, 0);
  return out;
}
