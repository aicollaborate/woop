import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import { useMemoStore } from '@features/memo/store/memo-store';
import { useWorkspaceRestoreStore } from '@features/workspace/store/workspace-restore-store';
import { closeAgentTarget, openAgentTarget } from './workspace-navigation';

export async function selectAndOpenAgentConversation(
  instanceId: string,
  options?: { history?: 'push' | 'skip' },
): Promise<void> {
  const normalized = instanceId.trim();
  if (!normalized) return;

  const host = await openAgentTarget(normalized, options);
  useWorkspaceRestoreStore.getState().selectAgentConversation(
    normalized,
    host === 'main-third',
  );
}

export function closeAgentConversationDetail(): void {
  closeAgentTarget();
  useWorkspaceRestoreStore.getState().closeAgentConversationDetail();
}

export function clearRestoredAgentConversation(instanceId: string): void {
  useWorkspaceRestoreStore.getState().clearAgentConversation(instanceId);
}

export async function restoreAgentConversationWorkspace(): Promise<void> {
  const restore = useWorkspaceRestoreStore.getState().agentConversation;
  const instanceId = restore.selectedInstanceId?.trim() ?? '';
  if (!instanceId) return;

  const instance = await useAgentSessionStore.getState().hydrateInstance(instanceId);
  if (!instance) {
    useWorkspaceRestoreStore.getState().clearAgentConversation(instanceId);
    return;
  }

  // Selection belongs to the conversations list. Only reopen the detail when
  // that list is still the restored middle-column destination.
  if (restore.detailOpen && useMemoStore.getState().activeFilter === 'agents') {
    await selectAndOpenAgentConversation(instanceId, { history: 'skip' });
  }
}
