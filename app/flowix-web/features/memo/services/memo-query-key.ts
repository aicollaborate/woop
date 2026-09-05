import type { ColorFilterValue } from '@features/memo/store';

export function getMemoQueryKey(
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
