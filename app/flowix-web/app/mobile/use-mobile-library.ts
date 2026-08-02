import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cloudSyncAvailable, type MobileTag } from './mobile-model';
import {
  mobileClient,
  type CloudState,
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
  const [activeDocument, setActiveDocument] = useState<OpenMemoSession | null>(null);
  const [message, setMessage] = useState('');
  const notebookIdRef = useRef<string | null>(null);
  const tagIdRef = useRef<string | null>(null);
  const listGenerationRef = useRef(0);
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

  const syncNow = useCallback(async (): Promise<boolean> => {
    if (!canSync) return false;
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

  const openMemo = useCallback(async (id: string) => {
    const session = await mobileClient.memos.openMemoSession(id);
    if (session) setActiveDocument(session);
  }, []);

  const createMemo = useCallback(async () => {
    const notebookId = notebookIdRef.current;
    if (!notebookId) return;
    const memo = await mobileClient.memos.addDocument(tagIdRef.current || undefined, notebookId);
    if (memo.id) await openMemo(memo.id);
  }, [openMemo]);

  const closeDocument = useCallback(() => {
    setActiveDocument(null);
    void loadNotebook();
  }, [loadNotebook]);

  const logout = useCallback(async () => {
    setCloudState(await mobileClient.cloud.logout());
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
    tags,
    closeDocument,
    createMemo,
    dismissMessage: () => setMessage(''),
    logout,
    openMemo,
    selectNotebook,
    selectTag,
    syncNow,
    updateCloudState,
  };
}
