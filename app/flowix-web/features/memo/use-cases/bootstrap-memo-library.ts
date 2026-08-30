import { notebookRepository } from '@features/memo/services';
import { useMemoStore, type Notebook } from '@features/memo/store/memo-store';

/**
 * Load the notebook collection before restoring any persisted document.
 *
 * Notebook navigation can start on a non-memo surface (files or agent
 * conversations), so this bootstrap must not depend on MemoList mounting.
 * The backend list is authoritative; persisted selection only contributes
 * the preferred notebook id.
 */
let bootstrapPromise: Promise<Notebook | null> | null = null;

async function performBootstrap(): Promise<Notebook | null> {
  const persistedNotebookId = useMemoStore.getState().selectedNotebookId
    ?? useMemoStore.getState().selectedNotebook?.id
    ?? null;
  const notebooks = await notebookRepository.list();
  const store = useMemoStore.getState();

  store.setNotebooks(notebooks);

  if (notebooks.length === 0) {
    store.setSelectedNotebook(null);
    store.setSelectedMemo(null);
    store.setMemos([]);
    return null;
  }

  const selectedNotebook = notebooks.find(
    (notebook) => notebook.id === persistedNotebookId,
  ) ?? notebooks[0];

  if (selectedNotebook.id !== persistedNotebookId) {
    // A missing persisted notebook also invalidates its persisted document.
    store.setSelectedMemo(null);
    store.setMemos([]);
  }
  store.setSelectedNotebook(selectedNotebook);

  return selectedNotebook;
}

export function bootstrapMemoLibrary(): Promise<Notebook | null> {
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = performBootstrap().finally(() => {
    bootstrapPromise = null;
  });
  return bootstrapPromise;
}
