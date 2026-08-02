import { memos, notebooks, type FilterType, type NotebookSortEntry, type SortType } from '@platform/tauri/client';
import type { MemoColor, Notebook } from '@features/memo';

export type { FilterType, SortType } from '@platform/tauri/client';

export const memoRepository = {
  list: (params?: {
    notebookId?: string;
    filter?: FilterType;
    sort?: SortType;
    tagId?: string;
  }) => memos.getMemos(params),
  create: (tag?: string, notebookId?: string) => memos.addDocument(tag, notebookId),
  delete: (id: string) => memos.deleteMemo(id),
  favorite: (id: string) => memos.favoriteMemo(id),
  unfavorite: (id: string) => memos.unfavoriteMemo(id),
  setColors: (id: string, colors: MemoColor[]) => memos.setMemoColors(id, colors),
};

export const notebookRepository = {
  list: (): Promise<Notebook[]> => notebooks.getAll(),
  create: (name: string, path: string, icon?: string | null) =>
    notebooks.create(name, path, icon),
  createFromCloud: (id: string, name: string, path: string, icon?: string | null) =>
    notebooks.createFromCloud(id, name, path, icon),
  update: (id: string, name?: string, icon?: string | null) =>
    notebooks.update(id, name, icon),
  /**
   * Reorder notebooks by submitting (id, sort) pairs to the backend.
   * `order` is the desired final sequence (id in the order it should appear);
   * sort values are assigned by the caller (typically `index * 10`).
   * Returns the freshly ordered notebook list.
   */
  reorder: (order: NotebookSortEntry[]) => notebooks.reorder(order),
};
