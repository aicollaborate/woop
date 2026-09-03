import {
  useFourthColumnStore,
  type FourthColumnTarget,
} from '@features/workspace/store/fourth-column-store';
import {
  workspaceContentIdentityKey,
  type WorkspaceContentIdentity,
} from '@features/workspace/store/workspace-content-identity';
import type { WorkspaceTarget } from '@features/workspace/store/workspace-target';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';
import { getThirdColumnContentState } from '@features/workspace/store/third-column-content-state';

export type WorkspaceContentLocation =
  | { host: 'main-third'; state: 'active' | 'pending' }
  | { host: 'fourth-column'; tabId: string };

function workspaceTargetIdentity(target: WorkspaceTarget): WorkspaceContentIdentity | null {
  switch (target.kind) {
    case 'memo':
      return { kind: 'memo', memoId: target.memoId };
    case 'external':
      return { kind: 'external', path: target.path };
    case 'agent-conversation':
      return { kind: 'agent-conversation', instanceId: target.instanceId };
    default:
      return null;
  }
}

export function fourthColumnTargetIdentity(
  target: FourthColumnTarget,
): WorkspaceContentIdentity {
  switch (target.kind) {
    case 'memo':
      return { kind: 'memo', memoId: target.memoId };
    case 'external_markdown':
    case 'external_text':
      return { kind: 'external', path: target.filePath };
    case 'agent_conversation':
      return { kind: 'agent-conversation', instanceId: target.instanceId };
  }
}

/**
 * Focus an already-open workspace target without opening a second surface.
 * The third column wins when legacy state already contains the target in both
 * columns; normal opens prevent that ambiguous state from being created.
 */
export function activateExistingWorkspaceContent(
  identity: WorkspaceContentIdentity,
): WorkspaceContentLocation | null {
  const key = workspaceContentIdentityKey(identity);
  if (!key) return null;

  const thirdColumn = getThirdColumnContentState();
  const pendingIdentity = thirdColumn.status === 'transitioning'
    ? workspaceTargetIdentity(thirdColumn.to)
    : null;
  if (pendingIdentity && workspaceContentIdentityKey(pendingIdentity) === key) {
    useWorkspaceFocusStore.getState().focusHost('main-third');
    return { host: 'main-third', state: 'pending' };
  }

  const thirdTarget = thirdColumn.status === 'empty'
    ? null
    : thirdColumn.status === 'transitioning'
      ? thirdColumn.from
      : thirdColumn.target;
  const thirdIdentity = thirdTarget ? workspaceTargetIdentity(thirdTarget) : null;
  if (thirdIdentity && workspaceContentIdentityKey(thirdIdentity) === key) {
    useWorkspaceFocusStore.getState().focusHost('main-third');
    return { host: 'main-third', state: 'active' };
  }

  const fourth = useFourthColumnStore.getState();
  const matchingTabs = fourth.tabs.filter(
    (tab) => workspaceContentIdentityKey(fourthColumnTargetIdentity(tab.target)) === key,
  );
  const tab = matchingTabs.find((candidate) => candidate.id === fourth.activeTabId)
    ?? matchingTabs[0];
  if (!tab) return null;

  fourth.commitTab(tab.id);
  return { host: 'fourth-column', tabId: tab.id };
}
