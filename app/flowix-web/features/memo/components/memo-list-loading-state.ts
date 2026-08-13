import type { ColorFilterValue } from '@features/memo/store';

export function getMemoListQueryKey(
  notebookId: string | undefined,
  filter: string,
  sort: string,
  tagId: string | null,
  colorFilter: ColorFilterValue,
  pluginId?: string | null,
): string {
  return [
    notebookId ?? '',
    filter,
    sort,
    filter === 'tagged' ? tagId ?? '' : '',
    filter === 'color' ? colorFilter : '',
    pluginId ?? '',
  ].join(':');
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
