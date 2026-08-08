import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cloudSyncAvailable, type MobileTag } from './mobile-model';
import {
  mobileClient,
  type CloudState,
  type CloudSyncStatus,
  type NotebookRecord,
  type OpenMemoSession,
} from '@platform/tauri/mobile-client';
import type { MemoItem } from '@/types/memo-item';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useMobileLibrary() {
  const [booting, setBooting] = useState(true);
  const [cloudState, setCloudState] = useState<CloudState | null>(null);
  const [notebooks, setNotebooks] = useState<NotebookRecord[]>([]);
  const [selectedNotebookId, setSelectedNotebookId] = useState<string | null>(null);
  const [tags, setTags] = useState<MobileTag[]>([]);
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [memoItems, setMemoItems] = useState<MemoItem[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<CloudSyncStatus | null>(null);
  const [activeDocument, setActiveDocument] = useState<OpenMemoSession | null>(null);
  const [message, setMessage] = useState('');
  const notebookIdRef = useRef<string | null>(null);
  const tagIdRef = useRef<string | null>(null);
  const listGenerationRef = useRef(0);
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

  const loadNotebooks = useCallback(async () => {
    const next = await mobileClient.notebooks.getAll();
    const current = notebookIdRef.current;
    const nextId = current && next.some((notebook) => notebook.id === current)
      ? current
      : next[0]?.id ?? null;
    if (nextId !== current) {
      tagIdRef.current = null;
      setSelectedTagId(null);
    }
    notebookIdRef.current = nextId;
    setNotebooks(next);
    setSelectedNotebookId(nextId);
    return nextId;
  }, []);

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
    } catch (error) {
      if (generation === listGenerationRef.current) setMessage(errorMessage(error));
    } finally {
      if (generation === listGenerationRef.current) setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        setCloudState(await mobileClient.initialize());
        const notebookId = await loadNotebooks();
        await loadNotebook(notebookId, null);
      } catch (error) {
        setMessage(errorMessage(error));
      } finally {
        setBooting(false);
      }
    })();
  }, [loadNotebook, loadNotebooks]);

  useEffect(() => {
    void loadNotebook(selectedNotebookId, selectedTagId);
  }, [loadNotebook, selectedNotebookId, selectedTagId]);

  useEffect(() => mobileClient.listenToCloudStateChanges((next) => {
    setCloudState(next);
    void (async () => {
      const notebookId = await loadNotebooks();
      await loadNotebook(notebookId, tagIdRef.current);
    })();
  }), [loadNotebook, loadNotebooks]);

  useEffect(() => mobileClient.listenToCloudSyncStatusChanges((next) => {
    setSyncStatus(next);
    setSyncing(next.state === 'queued' || next.state === 'checking' || next.state === 'syncing' || next.state === 'finalizing');
    if (next.state === 'error' && next.lastError) setMessage(next.lastError);
  }), []);

  const syncNow = useCallback(async (): Promise<boolean> => {
    if (!canSync) return false;
    if (syncPromiseRef.current) return syncPromiseRef.current;
    const operation = (async () => {
      setSyncing(true);
      setMessage('');
      try {
        await mobileClient.bootstrapCloud();
        const notebookId = await loadNotebooks();
        await loadNotebook(notebookId, tagIdRef.current);
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
  }, [canSync, loadNotebook, loadNotebooks]);

  const updateCloudState = useCallback(async (next: CloudState) => {
    setCloudState(next);
    const notebookId = await loadNotebooks();
    await loadNotebook(notebookId, tagIdRef.current);
  }, [loadNotebook, loadNotebooks]);

  const selectNotebook = useCallback((id: string) => {
    notebookIdRef.current = id;
    tagIdRef.current = null;
    setSelectedNotebookId(id);
    setSelectedTagId(null);
  }, []);

  const selectTag = useCallback((id: string | null) => {
    tagIdRef.current = id;
    setSelectedTagId(id);
  }, []);

  const createNotebook = useCallback(async (name: string): Promise<NotebookRecord | null> => {
    try {
      const created = await mobileClient.notebooks.create(name);
      notebookIdRef.current = created.id;
      tagIdRef.current = null;
      setNotebooks((current) => [...current, created]);
      setSelectedNotebookId(created.id);
      setSelectedTagId(null);
      await loadNotebook(created.id, null);
      return created;
    } catch (error) {
      setMessage(errorMessage(error));
      return null;
    }
  }, [loadNotebook]);

  const renameNotebook = useCallback(async (id: string, name: string): Promise<boolean> => {
    try {
      const updated = await mobileClient.notebooks.rename(id, name);
      setNotebooks((current) => current.map((notebook) => notebook.id === id ? updated : notebook));
      return true;
    } catch (error) {
      setMessage(errorMessage(error));
      return false;
    }
  }, []);

  const openMemo = useCallback(async (id: string) => {
    try {
      const session = await mobileClient.memos.openMemoSession(id);
      if (session) setActiveDocument(session);
      else setMessage('这篇笔记已不存在，请刷新列表后重试。');
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }, []);

  const createMemo = useCallback(async () => {
    const notebookId = notebookIdRef.current;
    if (!notebookId) return;
    try {
      const memo = await mobileClient.memos.addDocument(tagIdRef.current || undefined, notebookId);
      if (memo.id) await openMemo(memo.id);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }, [openMemo]);

  const closeDocument = useCallback(() => {
    setActiveDocument(null);
    void loadNotebook();
  }, [loadNotebook]);

  const deleteMemo = useCallback(async (id: string) => {
    try {
      if (!await mobileClient.memos.deleteMemo(id)) throw new Error('删除笔记失败');
      setMemoItems((current) => current.filter((memo) => memo.id !== id));
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

  return {
    activeDocument,
    booting,
    canSync,
    cloudState,
    loadingList,
    memoItems,
    message,
    notebooks,
    selectedNotebook,
    selectedNotebookId,
    selectedTag,
    selectedTagId,
    syncing,
    syncStatus,
    tags,
    closeDocument,
    createNotebook,
    createMemo,
    deleteMemo,
    dismissMessage: () => setMessage(''),
    logout,
    openMemo,
    selectNotebook,
    selectTag,
    renameNotebook,
    syncNow,
    toggleMemoFavorite,
    updateCloudState,
  };
}
