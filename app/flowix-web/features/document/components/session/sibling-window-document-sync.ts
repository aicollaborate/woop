import type { DocumentIdentity } from '@features/document/store/document-identity';
import type { MemoContentCommit } from '@/types/memo';
import {
  markMemoCommitApplied,
  shouldApplyMemoCommit,
} from '@features/document/store/memo-content-revision';

export interface MemoContentUpdatedEvent extends MemoContentCommit {
  id: string;
  path: string;
}

interface HandleSiblingWindowContentUpdateOptions {
  event: MemoContentUpdatedEvent;
  identity: DocumentIdentity;
  isDirty: boolean;
  onConflict: () => void;
  onDeferred?: (event: MemoContentUpdatedEvent) => void;
  clearSaveTimer: () => void;
  reloadDocument: (path: string, options: {
    preservePending: boolean;
    showLoading: boolean;
  }) => Promise<void>;
}

export type SiblingWindowContentUpdateResult = 'ignored' | 'conflict' | 'reloaded';

export async function handleSiblingWindowContentUpdate({
  event,
  identity,
  isDirty,
  onConflict,
  onDeferred,
  clearSaveTimer,
  reloadDocument,
}: HandleSiblingWindowContentUpdateOptions): Promise<SiblingWindowContentUpdateResult> {
  if (identity.kind !== 'memo' || event.id !== identity.id || !event.path) {
    return 'ignored';
  }

  if (!shouldApplyMemoCommit(event.id, event)) return 'ignored';

  if (isDirty) {
    onConflict();
    onDeferred?.(event);
    return 'conflict';
  }

  clearSaveTimer();
  await reloadDocument(event.path, { preservePending: false, showLoading: false });
  markMemoCommitApplied(event.id, event);
  return 'reloaded';
}
