import { canonicalPath } from '@/lib/path';
import {
  useDocumentHistoryStore,
  type DocumentHistoryEntry,
  type MemoHistoryEntry,
} from '@features/document/store/document-history-store';
import { useDocumentStore } from '@features/document/store/document-store';
import { useMemoStore, type Notebook } from '@features/memo/store/memo-store';
import { notebooks as notebooksClient } from '@platform/tauri/client';
import type { MemoItem } from '@/types/memo-item';

export type DocumentHistoryDirection = 'back' | 'forward';

function currentHistoryEntry(): DocumentHistoryEntry | null {
  const state = useDocumentStore.getState();
  const memo = state.activeMemoSession;
  if (memo) {
    return {
      kind: 'memo',
      memoId: memo.memoId,
      notebookId: memo.notebookId,
      notebookPath: memo.notebookPath,
      path: memo.path,
      openedAt: memo.openedAt,
    };
  }
  const external = state.activeExternalSession;
  if (external) {
    return {
      kind: 'external',
      path: external.path,
      scopePath: external.scopePath,
      openedAt: external.openedAt,
    };
  }
  return state.activeAgentConversationId
    ? {
        kind: 'agent-conversation',
        instanceId: state.activeAgentConversationId,
        openedAt: Date.now(),
      }
    : null;
}

function filenameFromPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function memoFromHistoryEntry(entry: MemoHistoryEntry): MemoItem {
  const existing = useMemoStore.getState().memos.find((memo) => memo.id === entry.memoId);
  if (existing) return existing;

  return {
    id: entry.memoId,
    filename: entry.title ?? filenameFromPath(entry.path),
    preview: '',
    tags: [],
    todos: [],
    agents: [],
    createdAt: 0,
    updatedAt: entry.openedAt,
    favorited: false,
    icon: null,
    colors: [],
    properties: {},
    isOpen: true,
  };
}

async function ensureNotebook(entry: MemoHistoryEntry): Promise<Notebook | null> {
  const memoStore = useMemoStore.getState();
  if (!entry.notebookId) return memoStore.selectedNotebook;
  if (memoStore.selectedNotebook?.id === entry.notebookId) return memoStore.selectedNotebook;

  let target = memoStore.notebooks.find((notebook) => notebook.id === entry.notebookId) ?? null;

  try {
    await notebooksClient.setCurrent(entry.notebookId);
  } catch (error) {
    console.warn('[document-navigation] Failed to switch notebook:', error);
    throw error;
  }

  if (!target) {
    await useMemoStore.getState().loadNotebooks();
    target = useMemoStore.getState().notebooks.find((notebook) => notebook.id === entry.notebookId) ?? null;
  }

  if (target) {
    useMemoStore.getState().setSelectedNotebook(target);
  }

  await useMemoStore.getState().loadMemos({ notebookId: entry.notebookId });
  return target;
}

async function openMemoHistoryEntry(entry: MemoHistoryEntry): Promise<void> {
  useMemoStore.getState().setSelectedMemo(memoFromHistoryEntry(entry));
  const notebook = await ensureNotebook(entry);
  const path = canonicalPath(entry.path);
  const memo = memoFromHistoryEntry(entry);
  const memoStore = useMemoStore.getState();

  if (!memoStore.memos.find((item) => item.id === memo.id)) {
    memoStore.upsertMemo(memo);
  }
  memoStore.setSelectedMemo(memo);
  await useDocumentStore.getState().openMemoDocument({
    memoId: entry.memoId,
    path,
    notebookId: entry.notebookId ?? notebook?.id ?? null,
    notebookPath: entry.notebookPath ?? notebook?.path ?? null,
    history: 'skip',
  });
}

function historyEntryKey(entry: DocumentHistoryEntry | null): string | null {
  if (!entry) return null;
  if (entry.kind === 'memo') return `memo:${entry.memoId}:${canonicalPath(entry.path)}`;
  if (entry.kind === 'agent-conversation') return `agent-conversation:${entry.instanceId}`;
  return `external:${canonicalPath(entry.path)}`;
}

async function openHistoryEntry(entry: DocumentHistoryEntry): Promise<void> {
  if (entry.kind === 'memo') {
    await openMemoHistoryEntry(entry);
    return;
  }
  if (entry.kind === 'agent-conversation') {
    await useDocumentStore.getState().openAgentConversation(entry.instanceId, { history: 'skip' });
    return;
  }
  await useDocumentStore.getState().openExternalDocument(entry.path, {
    history: 'skip',
    scopePath: entry.scopePath,
  });
}

export async function navigateDocumentHistory(direction: DocumentHistoryDirection): Promise<boolean> {
  const current = currentHistoryEntry();
  let target: DocumentHistoryEntry | null = null;

  while (true) {
    const history = useDocumentHistoryStore.getState();
    target = direction === 'back' ? history.peekBack() : history.peekForward();

    if (!target) return false;
    if (historyEntryKey(current) !== historyEntryKey(target)) {
      break;
    }

    if (direction === 'back') {
      useDocumentHistoryStore.getState().commitBackNavigation(null);
    } else {
      useDocumentHistoryStore.getState().commitForwardNavigation(null);
    }
  }

  if (direction === 'back') {
    useDocumentHistoryStore.getState().commitBackNavigation(current);
  } else {
    useDocumentHistoryStore.getState().commitForwardNavigation(current);
  }

  await openHistoryEntry(target);

  return true;
}
