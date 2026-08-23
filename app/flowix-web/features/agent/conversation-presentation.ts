import type { AgentConversationInstance, AgentConversationSource } from '@features/agent/store/agent-conversation-types';

/** Shared display data for the embedded card and standalone conversation detail. */
export interface AgentConversationPresentation {
  title: string;
  source: AgentConversationSource | null;
  hasSourceDocument: boolean;
  runtimeCwd: string | undefined;
}

export function getAgentConversationRuntimeCwd(
  instance: Pick<AgentConversationInstance, 'runtimeConfig'> | null | undefined,
): string | undefined {
  const snapshotCwd = instance?.runtimeConfig?.workspaceSnapshot?.cwd;
  const legacyCwd = instance?.runtimeConfig?.cwd;
  const value = (
    typeof snapshotCwd === 'string'
      ? snapshotCwd
      : typeof legacyCwd === 'string'
        ? legacyCwd
        : ''
  ).trim();
  return value || undefined;
}

export function getAgentConversationPresentation(
  instance: Pick<AgentConversationInstance, 'title' | 'source' | 'runtimeConfig'>,
  fallbackTitle: string,
): AgentConversationPresentation {
  const source = instance.source ?? null;
  return {
    title: instance.title?.trim() || fallbackTitle,
    source,
    hasSourceDocument: Boolean(source?.memoId || source?.documentPath),
    runtimeCwd: getAgentConversationRuntimeCwd(instance),
  };
}
