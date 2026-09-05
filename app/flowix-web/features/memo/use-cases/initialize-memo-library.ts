import { notebookRepository } from '@features/memo/services';
import { getMemoQueryKey } from '@features/memo/services/memo-query-key';
import { useMemoStore } from '@features/memo/store/memo-store';
import { useTagStore } from '@features/memo/store/tag-store';

/**
 * Owns the main-window critical path: resolve the authoritative notebook and
 * load the first memo query before the UI enters its interactive state.
 *
 * Components may mount before this promise completes, but they must not start
 * their own bootstrap request. This makes startup deterministic while leaving
 * later filtering and notebook switching to their existing flows.
 */
let initializationPromise: Promise<void> | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function performInitialization(): Promise<void> {
  const store = useMemoStore.getState();
  store.setStartupPhase('loading');

  try {
    const notebooks = await notebookRepository.list();
    const latestStore = useMemoStore.getState();
    const persistedNotebookId = latestStore.selectedNotebookId
      ?? latestStore.selectedNotebook?.id
      ?? null;

    latestStore.setNotebooks(notebooks);

    if (notebooks.length === 0) {
      latestStore.setSelectedNotebook(null);
      latestStore.setSelectedMemo(null);
      latestStore.setMemos([]);
      latestStore.setStartupReady('');
      return;
    }

    const selectedNotebook = notebooks.find(
      (notebook) => notebook.id === persistedNotebookId,
    ) ?? notebooks[0];

    if (selectedNotebook.id !== persistedNotebookId) {
      latestStore.setSelectedMemo(null);
      latestStore.setMemos([]);
    }
    latestStore.setSelectedNotebook(selectedNotebook);

    const current = useMemoStore.getState();
    const selectedTagId = useTagStore.getState().selectedTagId;
    const filter = current.activeFilter;
    const sort = current.activeSort;
    const tagId = filter === 'tagged' ? selectedTagId ?? undefined : undefined;
    const queryKey = getMemoQueryKey(
      selectedNotebook.id,
      filter,
      sort,
      tagId ?? null,
      current.colorFilter,
      current.activePluginId,
    );

    const memoLoadApplied = await current.loadMemos({
      notebookId: selectedNotebook.id,
      filter,
      sort,
      tagId,
    });

    if (!memoLoadApplied) {
      // A newer interactive load or memo mutation superseded the startup
      // request. Let the list effect own the current query instead of marking
      // an unverified snapshot as the initial result.
      useMemoStore.getState().setStartupReady('');
      return;
    }

    // A user action should be able to supersede startup. Do not publish a
    // response for a notebook that is no longer selected.
    const afterLoad = useMemoStore.getState();
    const afterLoadQueryKey = getMemoQueryKey(
      afterLoad.selectedNotebook?.id,
      afterLoad.activeFilter,
      afterLoad.activeSort,
      afterLoad.activeFilter === 'tagged'
        ? useTagStore.getState().selectedTagId
        : null,
      afterLoad.colorFilter,
      afterLoad.activePluginId,
    );
    if (
      afterLoad.selectedNotebook?.id !== selectedNotebook.id
      || afterLoadQueryKey !== queryKey
    ) {
      // A notebook navigation transaction won the race while startup was in
      // flight. Let the normal interactive query effect load the latest query.
      afterLoad.setStartupReady('');
      return;
    }

    afterLoad.setStartupReady(queryKey);
  } catch (error) {
    useMemoStore.getState().setStartupPhase('error', errorMessage(error));
    throw error;
  }
}

export function initializeMemoLibrary(): Promise<void> {
  if (initializationPromise) return initializationPromise;

  initializationPromise = performInitialization().finally(() => {
    initializationPromise = null;
  });
  return initializationPromise;
}
