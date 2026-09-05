import { useEffect } from 'react';
import {
  type ColorFilterValue,
  type ExtendedFilterType,
  type MemoLibraryStartupPhase,
  type MemoStore,
} from '@features/memo/store/memo-store';
import type { SortType } from '@features/memo/services';
import { getMemoListQueryKey } from './memo-list-loading-state';

export interface MemoListDataLoaderProps {
  dataLoadingEnabled: boolean;
  startupPhase: MemoLibraryStartupPhase;
  initialMemoQueryKey: string | null;
  memoListQueryKey: string | null;
  selectedNotebookId: string | undefined;
  activeFilter: ExtendedFilterType;
  activeSort: SortType;
  activeTagId: string | null;
  colorFilter: ColorFilterValue;
  activePluginId: string | null;
  refreshTrigger: number;
  loadedMemoListQueryKey: string | null;
  loadMemos: MemoStore['loadMemos'];
  setLoadedMemoListQueryKey: (queryKey: string | null) => void;
  setIsMemoListLoading: (loading: boolean) => void;
  onLoadError: (error: unknown) => void;
}

/**
 * Owns the memo-list query effect separately from the large list view.
 * Keeping this as a small component makes the startup/no-duplicate-request
 * contract directly testable without mounting the whole navigation surface.
 */
export function MemoListDataLoader({
  dataLoadingEnabled,
  startupPhase,
  initialMemoQueryKey,
  memoListQueryKey,
  selectedNotebookId,
  activeFilter,
  activeSort,
  activeTagId,
  colorFilter,
  activePluginId,
  refreshTrigger,
  loadedMemoListQueryKey,
  loadMemos,
  setLoadedMemoListQueryKey,
  setIsMemoListLoading,
  onLoadError,
}: MemoListDataLoaderProps) {
  useEffect(() => {
    let cancelled = false;
    if (!dataLoadingEnabled) {
      setIsMemoListLoading(false);
      return () => {
        cancelled = true;
      };
    }
    if (startupPhase !== 'ready') {
      setIsMemoListLoading(startupPhase === 'loading');
      return () => {
        cancelled = true;
      };
    }
    if (!selectedNotebookId) {
      setIsMemoListLoading(false);
      setLoadedMemoListQueryKey(null);
      return () => {
        cancelled = true;
      };
    }

    const queryKey = getMemoListQueryKey(
      selectedNotebookId,
      activeFilter,
      activeSort,
      activeTagId,
      colorFilter,
      activePluginId,
    );
    const shouldShowLoading = queryKey !== loadedMemoListQueryKey;

    async function loadMemoListOnly() {
      // The startup orchestrator has already loaded this exact query. Mark it
      // as rendered locally without issuing a duplicate IPC request.
      if (initialMemoQueryKey === queryKey && memoListQueryKey === queryKey) {
        setLoadedMemoListQueryKey(queryKey);
        setIsMemoListLoading(false);
        return;
      }
      if (shouldShowLoading) {
        setIsMemoListLoading(true);
      }
      try {
        const applied = await loadMemos({
          notebookId: selectedNotebookId,
          filter: activeFilter,
          sort: activeSort,
          tagId: activeTagId ?? undefined,
        });
        if (cancelled || !applied) return;
        setLoadedMemoListQueryKey(queryKey);
      } catch (error) {
        if (!cancelled) onLoadError(error);
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
  }, [
    activeFilter,
    activePluginId,
    activeSort,
    activeTagId,
    colorFilter,
    dataLoadingEnabled,
    initialMemoQueryKey,
    loadMemos,
    memoListQueryKey,
    onLoadError,
    refreshTrigger,
    selectedNotebookId,
    setIsMemoListLoading,
    setLoadedMemoListQueryKey,
    startupPhase,
  ]);

  return null;
}
