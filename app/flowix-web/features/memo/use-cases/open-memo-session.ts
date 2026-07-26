import { joinNotebookMemoPath } from '@/lib/path';
import { useDocumentStore } from '@features/document';
import { useMemoStore, type MemoItem, type Notebook } from '@features/memo';
import { createLogger } from '@/lib/logger';

const logger = createLogger('memo-session');

export function resolveMemoSessionPath(memo: MemoItem, notebook: Notebook | null): string | null {
  return notebook?.path ? joinNotebookMemoPath(notebook.path, memo.filename) : memo.filename ?? null;
}

export async function openMemoSession(memo: MemoItem, notebook: Notebook | null): Promise<void> {
  const fullPath = resolveMemoSessionPath(memo, notebook);
  const previousSelectedMemo = useMemoStore.getState().selectedMemo;
  useMemoStore.getState().setSelectedMemo(memo);

  try {
    await useDocumentStore.getState().openMemoDocument({
      memoId: memo.id,
      path: fullPath,
      notebookId: notebook?.id ?? null,
      notebookPath: notebook?.path ?? null,
    });
  } catch (error) {
    logger.error('open document failed', { error, memoId: memo.id });
    useMemoStore.getState().setSelectedMemo(previousSelectedMemo);
  }
}

let restoringMemoId: string | null = null;

/**
 * Restore the memo persisted by the workspace store exactly once at main
 * window startup. Keeping this orchestration outside MemoList prevents a
 * hover/secondary list instance from reopening a document and avoids a
 * mount-only React effect with captured state.
 */
export async function restorePersistedMemoSession(): Promise<void> {
  const memoState = useMemoStore.getState();
  const memo = memoState.selectedMemo;
  if (!memo || restoringMemoId === memo.id) return;

  const documentState = useDocumentStore.getState();
  if (documentState.currentDocumentSource === 'external') return;
  if (documentState.activeMemoSession?.memoId === memo.id) return;

  restoringMemoId = memo.id;
  try {
    await openMemoSession(memo, memoState.selectedNotebook);
  } finally {
    if (restoringMemoId === memo.id) restoringMemoId = null;
  }
}
