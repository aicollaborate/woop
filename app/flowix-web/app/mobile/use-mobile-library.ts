import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cloudSyncAvailable, type MobileTag } from './mobile-model';
import { mobileErrorMessage } from './error-message';
import {
  mobileClient,
  type CloudState,
  type CloudSyncStatus,
  type MobileLibrarySnapshot,
  type NotebookRecord,
  type OpenMemoSession,
} from '@platform/tauri/mobile-client';
import type { MemoItem } from '@/types/memo-item';

const SELECTED_NOTEBOOK_STORAGE_KEY = 'flowix:mobile:selected-notebook';
const OPEN_MEMO_TIMEOUT_MS = 10_000;

export interface MobileOpenMemoError {
  id: string;
  filename: string;
  kind: 'missing' | 'failed';
  message: string;
}

function errorMessage(error: unknown): string {
  return mobileErrorMessage(error);
}

function readPersistedNotebookId(): string | null {
  try {
    return typeof window === 'undefined'
      ? null
      : window.localStorage.getItem(SELECTED_NOTEBOOK_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistNotebookId(id: string | null): void {
  try {
    if (typeof window === 'undefined') return;
    if (id) window.localStorage.setItem(SELECTED_NOTEBOOK_STORAGE_KEY, id);
    else window.localStorage.removeItem(SELECTED_NOTEBOOK_STORAGE_KEY);
  } catch {
    // Local storage is a convenience; it must not prevent the library from loading.
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(
      () => reject(new Error('打开笔记超时，请重试。')),
      timeoutMs,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

export function useMobileLibrary() {
  const [booting, setBooting] = useState(true);
  const [cloudState, setCloudState] = useState<CloudState | null>(null);
  const [notebooks, setNotebooks] = useState<NotebookRecord[]>([]);
  const [selectedNotebookId, setSelectedNotebookId] = useState<string | null>(null);
  const [tags, setTags] = useState<MobileTag[]>([]);
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [memoItems, setMemoItems] = useState<MemoItem[]>([]);
  const [searchItems, setSearchItems] = useState<MemoItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<CloudSyncStatus | null>(null);
  const [activeDocument, setActiveDocument] = useState<OpenMemoSession | null>(null);
  const [openingMemo, setOpeningMemo] = useState<{ id: string; filename: string } | null>(null);
  const [openMemoError, setOpenMemoError] = useState<MobileOpenMemoError | null>(null);
  const [message, setMessage] = useState('');
  const notebookIdRef = useRef<string | null>(null);
  const tagIdRef = useRef<string | null>(null);
  const listGenerationRef = useRef(0);
  const searchGenerationRef = useRef(0);
  const searchQueryRef = useRef('');
  const openRequestRef = useRef(0);
  const syncPromiseRef = useRef<Promise<boolean> | null>(null);
  const canSync = cloudSyncAvailable(cloudState);

  const selectedNotebook = useMemo(
    () => notebooks.find((notebook) => notebook.id === selectedNotebookId) ?? null,
    [notebooks, selectedNotebookId],
  );
  const selectedTag = useMemo(
    () => tags.find((tag) => tag.id === selectedTagId) ?? null,
    [selectedTagId, tags],
  );
  const visibleMemoItems = useMemo(
    () => searchQuery ? searchItems : memoItems,
    [memoItems, searchItems, searchQuery],
  );

  const searchMemos = useCallback(async (query: string) => {
    const normalizedQuery = query.trim();
    const generation = ++searchGenerationRef.current;
    searchQueryRef.current = normalizedQuery;
    if (!normalizedQuery) {
      setSearchQuery('');
      setSearchItems([]);
      setSearching(false);
      return;
    }

    const notebookId = notebookIdRef.current;
    if (!notebookId) {
      setSearchQuery(normalizedQuery);
      setSearchItems([]);
      setSearching(false);
      return;
    }

    setSearchQuery(normalizedQuery);
    setSearching(true);
    try {
      const response = await mobileClient.memos.search({
        notebookId,
        tagId: tagIdRef.current || undefined,
        query: normalizedQuery,
      });
      if (generation === searchGenerationRef.current) setSearchItems(response.memos);
    } catch (error) {
      if (generation === searchGenerationRef.current) {
        setSearchItems([]);
        setMessage(errorMessage(error));
      }
    } finally {
      if (generation === searchGenerationRef.current) setSearching(false);
    }
  }, []);

  const applyLibrarySnapshot = useCallback((snapshot: MobileLibrarySnapshot) => {
    const previousNotebookId = notebookIdRef.current;
    const nextNotebookId = snapshot.selectedNotebookId;
    const nextTagId = nextNotebookId === previousNotebookId
      && tagIdRef.current
      && snapshot.tags.some((tag) => tag.id === tagIdRef.current)
      ? tagIdRef.current
      : null;
    tagIdRef.current = nextTagId;
    setSelectedTagId(nextTagId);
    notebookIdRef.current = nextNotebookId;
    persistNotebookId(nextNotebookId);
    setNotebooks(snapshot.notebooks);
    setSelectedNotebookId(nextNotebookId);
    setTags(snapshot.tags);
    setMemoItems(snapshot.memos);
    return nextNotebookId;
  }, []);

  const loadNotebooks = useCallback(async () => {
    const generation = ++listGenerationRef.current;
    setLoadingList(true);
    try {
      const snapshot = await mobileClient.notebooks.getLibrarySnapshot({
        preferredNotebookId: notebookIdRef.current ?? readPersistedNotebookId() ?? undefined,
        selectedTagId: tagIdRef.current || undefined,
      });
      if (generation !== listGenerationRef.current) return notebookIdRef.current;
      const notebookId = applyLibrarySnapshot(snapshot);
      if (searchQueryRef.current) void searchMemos(searchQueryRef.current);
      return notebookId;
    } finally {
      if (generation === listGenerationRef.current) setLoadingList(false);
    }
  }, [applyLibrarySnapshot, searchMemos]);

  const loadNotebook = useCallback(async (
    notebookId = notebookIdRef.current,
    tagId = tagIdRef.current,
  ) => {
    const generation = ++listGenerationRef.current;
    if (!notebookId) {
      setTags([]);
      setMemoItems([]);
      setLoadingList(false);
      return;
    }
    setLoadingList(true);
    try {
      const [tagResponse, memoResponse] = await Promise.all([
        mobileClient.tags.getAll(notebookId),
        mobileClient.memos.getMemos({
          notebookId,
          filter: tagId ? 'tagged' : 'all',
          sort: 'updatedAt',
          tagId: tagId || undefined,
        }),
      ]);
      if (generation !== listGenerationRef.current) return;
      setTags(tagResponse.tags);
      setMemoItems(memoResponse.memos);
      if (!tagId) {
        setNotebooks((current) => current.map((notebook) => (
          notebook.id === notebookId ? { ...notebook, memoCount: memoResponse.memos.length } : notebook
        )));
      }
      if (searchQueryRef.current) void searchMemos(searchQueryRef.current);
    } catch (error) {
      if (generation === listGenerationRef.current) setMessage(errorMessage(error));
    } finally {
      if (generation === listGenerationRef.current) setLoadingList(false);
    }
  }, [searchMemos]);

  useEffect(() => {
    void (async () => {
      try {
        setCloudState(await mobileClient.initialize());
        await loadNotebooks();
      } catch (error) {
        setMessage(errorMessage(error));
      } finally {
        setBooting(false);
      }
    })();
  }, [loadNotebooks]);

  useEffect(() => mobileClient.listenToCloudStateChanges((next) => {
    setCloudState(next);
    void (async () => {
      await loadNotebooks();
    })();
  }), [loadNotebooks]);

  useEffect(() => mobileClient.listenToCloudSyncStatusChanges((next) => {
    setSyncStatus(next);
    setSyncing(next.state === 'queued' || next.state === 'checking' || next.state === 'syncing' || next.state === 'finalizing');
    if (next.state === 'error' && next.lastError) setMessage(errorMessage(next.lastError));
  }), []);

  const syncNow = useCallback(async (): Promise<boolean> => {
    if (!canSync) return false;
    if (syncPromiseRef.current) return syncPromiseRef.current;
    const operation = (async () => {
      setSyncing(true);
      setMessage('');
      try {
        await mobileClient.bootstrapCloud();
        await loadNotebooks();
        setCloudState(await mobileClient.cloud.getState());
        return true;
      } catch (error) {
        setMessage(errorMessage(error));
        return true;
      } finally {
        setSyncing(false);
      }
    })();
    syncPromiseRef.current = operation;
    try {
      return await operation;
    } finally {
      if (syncPromiseRef.current === operation) syncPromiseRef.current = null;
    }
  }, [canSync, loadNotebooks]);

  const updateCloudState = useCallback(async (next: CloudState) => {
    setCloudState(next);
    await loadNotebooks();
  }, [loadNotebooks]);

  const selectNotebook = useCallback((id: string) => {
    notebookIdRef.current = id;
    persistNotebookId(id);
    tagIdRef.current = null;
    setSelectedNotebookId(id);
    setSelectedTagId(null);
    searchQueryRef.current = '';
    setSearchQuery('');
    setSearchItems([]);
    setSearching(false);
    void loadNotebooks();
  }, [loadNotebooks]);

  const selectTag = useCallback((id: string | null) => {
    tagIdRef.current = id;
    setSelectedTagId(id);
    searchQueryRef.current = '';
    setSearchQuery('');
    setSearchItems([]);
    setSearching(false);
    void loadNotebooks();
  }, [loadNotebooks]);

  const createNotebook = useCallback(async (name: string): Promise<NotebookRecord | null> => {
    try {
      const created = await mobileClient.notebooks.create(name);
      notebookIdRef.current = created.id;
      persistNotebookId(created.id);
      tagIdRef.current = null;
      setNotebooks((current) => [...current, { ...created, memoCount: 0 }]);
      setSelectedNotebookId(created.id);
      setSelectedTagId(null);
      await loadNotebooks();
      return created;
    } catch (error) {
      setMessage(errorMessage(error));
      return null;
    }
  }, [loadNotebooks]);

  const renameNotebook = useCallback(async (id: string, name: string): Promise<boolean> => {
    try {
      const updated = await mobileClient.notebooks.rename(id, name);
      setNotebooks((current) => current.map((notebook) => notebook.id === id ? { ...notebook, ...updated } : notebook));
      return true;
    } catch (error) {
      setMessage(errorMessage(error));
      return false;
    }
  }, []);

  const deleteNotebook = useCallback(async (id: string): Promise<boolean> => {
    try {
      if (!await mobileClient.notebooks.delete(id)) throw new Error('删除笔记本失败');
      await loadNotebooks();
      setMessage('笔记本已删除。');
      return true;
    } catch (error) {
      const message = errorMessage(error);
      setMessage(message.includes('CANNOT_DELETE_LAST_NOTEBOOK') ? '至少保留一个笔记本。' : message);
      return false;
    }
  }, [loadNotebooks]);

  const openMemo = useCallback(async (id: string) => {
    const request = ++openRequestRef.current;
    const listedMemo = memoItems.find((memo) => memo.id === id)
      ?? searchItems.find((memo) => memo.id === id);
    const filename = listedMemo?.filename || '笔记';
    setOpenMemoError(null);
    setOpeningMemo({ id, filename });
    try {
      const session = await withTimeout(
        mobileClient.memos.openMemoSession(id),
        OPEN_MEMO_TIMEOUT_MS,
      );
      if (request !== openRequestRef.current) return;
      if (session) setActiveDocument(session);
      else {
        // A sync or external file change can invalidate a list row between
        // listing and opening it. Remove it immediately, then refresh tags and
        // the complete list without making the user retry the action.
        await loadNotebook();
        // Keep the row hidden even if a concurrent list response was produced
        // from an index that has not been pruned by the native command yet.
        setMemoItems((current) => current.filter((memo) => memo.id !== id));
        setSearchItems((current) => current.filter((memo) => memo.id !== id));
        if (request === openRequestRef.current) {
          setOpenMemoError({
            id,
            filename,
            kind: 'missing',
            message: '这篇笔记可能已被移动或删除。列表已更新。',
          });
        }
      }
    } catch (error) {
      if (request === openRequestRef.current) {
        setOpenMemoError({
          id,
          filename,
          kind: 'failed',
          message: errorMessage(error) || '读取笔记时遇到未知错误。',
        });
      }
    } finally {
      if (request === openRequestRef.current) setOpeningMemo(null);
    }
  }, [loadNotebook, memoItems, searchItems]);

  const createMemo = useCallback(async () => {
    const notebookId = notebookIdRef.current;
    if (!notebookId) return;
    try {
      const memo = await mobileClient.memos.addDocument(tagIdRef.current || undefined, notebookId);
      setNotebooks((current) => current.map((notebook) => (
        notebook.id === notebookId && notebook.memoCount != null
          ? { ...notebook, memoCount: notebook.memoCount + 1 }
          : notebook
      )));
      if (memo.id) await openMemo(memo.id);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }, [openMemo]);

  const closeDocument = useCallback(() => {
    openRequestRef.current += 1;
    setOpeningMemo(null);
    setOpenMemoError(null);
    setActiveDocument(null);
    void loadNotebook();
  }, [loadNotebook]);

  const deleteMemo = useCallback(async (id: string) => {
    try {
      if (!await mobileClient.memos.deleteMemo(id)) throw new Error('删除笔记失败');
      setMemoItems((current) => current.filter((memo) => memo.id !== id));
      setSearchItems((current) => current.filter((memo) => memo.id !== id));
      const notebookId = notebookIdRef.current;
      setNotebooks((current) => current.map((notebook) => (
        notebook.id === notebookId && notebook.memoCount != null
          ? { ...notebook, memoCount: Math.max(0, notebook.memoCount - 1) }
          : notebook
      )));
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }, []);

  const toggleMemoFavorite = useCallback(async (memo: MemoItem) => {
    try {
      const ok = memo.favorited
        ? await mobileClient.memos.unfavoriteMemo(memo.id)
        : await mobileClient.memos.favoriteMemo(memo.id);
      if (!ok) throw new Error('置顶操作失败');
      await loadNotebook();
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }, [loadNotebook]);

  const logout = useCallback(async () => {
    try {
      setCloudState(await mobileClient.cloud.logout());
      return true;
    } catch (error) {
      setMessage(errorMessage(error));
      return false;
    }
  }, []);

  const dismissMessage = useCallback(() => setMessage(''), []);

  return {
    activeDocument,
    booting,
    canSync,
    cloudState,
    loadingList,
    memoItems: visibleMemoItems,
    message,
    notebooks,
    openMemoError,
    openingMemo,
    selectedNotebook,
    selectedNotebookId,
    selectedTag,
    selectedTagId,
    searching,
    syncing,
    syncStatus,
    tags,
    closeDocument,
    createNotebook,
    deleteNotebook,
    createMemo,
    deleteMemo,
    dismissMessage,
    logout,
    openMemo,
    selectNotebook,
    selectTag,
    searchMemos,
    renameNotebook,
    syncNow,
    toggleMemoFavorite,
    updateCloudState,
  };
}
