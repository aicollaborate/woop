import type { MemoItem, MemoStore } from '@features/memo';

// Re-exported for callers that import DocumentBuffer from this module.
// The canonical definition lives in lib/store/document-buffer.ts so that
// the document store layer (which is window-agnostic) can use it.
export type { DocumentBuffer } from '@features/document/store/document-buffer';

export function extractBodyContent(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

export function countTextUnits(content: string): number {
  const chineseChars = content.match(/\p{Script=Han}/gu)?.length ?? 0;
  const englishWords = content.match(/[A-Za-z]+/g)?.length ?? 0;

  return chineseChars + englishWords;
}

export function joinPath(basePath: string, filePath: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith('/') || filePath.startsWith('\\')) {
    return filePath;
  }
  return `${basePath.replace(/[\\/]+$/, '')}/${filePath.replace(/^[\\/]+/, '')}`;
}

export function findMemoById(
  state: Pick<MemoStore, 'memos' | 'selectedMemo'>,
  memoId: string | null | undefined,
): MemoItem | null {
  if (!memoId) return null;
  return state.memos.find((memo) => memo.id === memoId)
    ?? (state.selectedMemo?.id === memoId ? state.selectedMemo : null);
}
