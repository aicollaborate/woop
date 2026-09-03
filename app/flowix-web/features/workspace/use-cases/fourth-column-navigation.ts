import { displayTitleFromFilename } from '@/lib/utils';
import { joinNotebookMemoPath } from '@/lib/path';
import type { MemoItem, Notebook } from '@features/memo';
import { memos as memosClient } from '@platform/tauri/client';
import {
  useFourthColumnStore,
  type FourthColumnOpenDisposition,
  type FourthColumnTarget,
} from '@features/workspace/store/fourth-column-store';
import {
  activateExistingWorkspaceContent,
  fourthColumnTargetIdentity,
} from './workspace-content-activation';

export type FourthColumnOpenResult =
  | { host: 'main-third'; alreadyOpen: true }
  | { host: 'fourth-column'; tabId: string; alreadyOpen: boolean };

function openResult(
  location: ReturnType<typeof activateExistingWorkspaceContent>,
): FourthColumnOpenResult | null {
  if (!location) return null;
  return location.host === 'main-third'
    ? { host: 'main-third', alreadyOpen: true }
    : { host: 'fourth-column', tabId: location.tabId, alreadyOpen: true };
}

function targetTabTitle(target: FourthColumnTarget): string {
  const filenameFromPath = (path: string) => path.split(/[\\/]/).pop() ?? path;

  switch (target.kind) {
    case 'memo':
    case 'external_markdown':
    case 'external_text':
      return displayTitleFromFilename(filenameFromPath(target.filePath));
    case 'agent_conversation':
      return 'Agent 会话';
  }
}

export function openFourthColumnTarget(
  target: FourthColumnTarget,
  disposition: FourthColumnOpenDisposition = 'focus-existing',
): FourthColumnOpenResult {
  const id = target.kind === 'memo'
    ? `memo:${target.memoId}`
    : target.kind === 'agent_conversation'
      ? `agent:${target.instanceId}`
      : `${target.kind}:${target.filePath}`;

  if (disposition === 'focus-existing') {
    const existing = activateExistingWorkspaceContent(fourthColumnTargetIdentity(target));
    const result = openResult(existing);
    if (result) return result;
  }

  const tabId = useFourthColumnStore.getState().openTab({
    id,
    title: targetTabTitle(target),
    icon: null,
    target,
  }, disposition);
  return { host: 'fourth-column', tabId, alreadyOpen: false };
}

export function openFourthColumnMemo(
  memo: MemoItem,
  notebook: Notebook | null,
  disposition: FourthColumnOpenDisposition = 'focus-existing',
): FourthColumnOpenResult {
  const filePath = notebook?.path
    ? joinNotebookMemoPath(notebook.path, memo.filename) ?? memo.filename
    : memo.filename;

  return openFourthColumnTarget({
    kind: 'memo',
    memoId: memo.id,
    notebookId: notebook?.id ?? '',
    notebookPath: notebook?.path ?? '',
    filePath,
  }, disposition);
}

export async function openFourthColumnMemoById(memoId: string): Promise<FourthColumnOpenResult> {
  const existing = activateExistingWorkspaceContent({ kind: 'memo', memoId });
  const result = openResult(existing);
  if (result) return result;

  // `MemoItem` deliberately has no notebook field. Resolving the path from
  // the selected notebook would open a background-created memo in the wrong
  // notebook, so use the backend's authoritative memo session response.
  const session = await memosClient.openMemoSession(memoId);
  if (!session) throw new Error(`Memo is unavailable: ${memoId}`);

  return openFourthColumnTarget({
    kind: 'memo',
    memoId: session.memo.id,
    notebookId: session.notebookId,
    notebookPath: session.notebookPath,
    filePath: session.path,
  });
}

export function openFourthColumnMarkdown(filePath: string): FourthColumnOpenResult {
  return openFourthColumnTarget({ kind: 'external_markdown', filePath });
}

export function openFourthColumnText(filePath: string, scopePath: string): FourthColumnOpenResult {
  return openFourthColumnTarget({ kind: 'external_text', filePath, scopePath });
}

export function openFourthColumnAgentConversation(instanceId: string): FourthColumnOpenResult {
  return openFourthColumnTarget({ kind: 'agent_conversation', instanceId });
}
