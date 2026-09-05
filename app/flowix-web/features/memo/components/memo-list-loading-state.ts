import type { ColorFilterValue } from '@features/memo/store';
import { getMemoQueryKey } from '@features/memo/services/memo-query-key';

export function getMemoListQueryKey(
  notebookId: string | undefined,
  filter: string,
  sort: string,
  tagId: string | null,
  colorFilter: ColorFilterValue,
  pluginId?: string | null,
): string {
  return getMemoQueryKey(notebookId, filter, sort, tagId, colorFilter, pluginId);
}

export function shouldShowMemoListLoading({
  selectedNotebookId,
  isMemoListLoading,
  currentMemoListQueryKey,
  loadedMemoListQueryKey,
}: {
  selectedNotebookId: string | undefined;
  isMemoListLoading: boolean;
  currentMemoListQueryKey: string;
  loadedMemoListQueryKey: string | null;
}): boolean {
  if (!selectedNotebookId) return false;
  return isMemoListLoading || currentMemoListQueryKey !== loadedMemoListQueryKey;
}
