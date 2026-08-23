import { STORAGE_KEYS } from '@/lib/constants';
import {
  DEFAULT_AGENT_TYPE_KEY,
  isAgentTypeSelectable,
  normalizeAgentTypeKey,
} from '@/lib/agent-types';
import { normalizeCodexPermissionMode } from '@features/agent/runtime/agent-runtime-spec';
import {
  DEFAULT_AGENT_SESSION_META,
  type AgentSessionMeta,
} from '@features/agent/store/session-state';

/** Migrate the legacy flat chat-store payload into the session metadata slice. */
function migrateChatPersistToSessionMeta(): AgentSessionMeta | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.CHAT);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: Record<string, unknown> };
    const old = parsed.state;
    if (!old || typeof old !== 'object') return null;
    const d = DEFAULT_AGENT_SESSION_META;
    return {
      ...d,
      activeThreadIds: old.activeThreadIds as AgentSessionMeta['activeThreadIds'] ?? d.activeThreadIds,
      activeAgentTypeKey: old.activeAgentTypeKey as AgentSessionMeta['activeAgentTypeKey'] ?? d.activeAgentTypeKey,
      threadTypes: old.threadTypes as AgentSessionMeta['threadTypes'] ?? d.threadTypes,
      currentThreadTitles: old.currentThreadTitles as AgentSessionMeta['currentThreadTitles'] ?? d.currentThreadTitles,
      externalSessionResolutions: old.externalSessionResolutions as AgentSessionMeta['externalSessionResolutions'] ?? d.externalSessionResolutions,
      threadLists: d.threadLists,
      lastRunningRunsReconciledAt: d.lastRunningRunsReconciledAt,
      settings: {
        ...d.settings,
        agentPermissionMode: old.agentPermissionMode as AgentSessionMeta['settings']['agentPermissionMode'] ?? d.settings.agentPermissionMode,
        agentCodexModel: old.agentCodexModel as AgentSessionMeta['settings']['agentCodexModel'] ?? d.settings.agentCodexModel,
        agentCodexReasoningEffort: old.agentCodexReasoningEffort as AgentSessionMeta['settings']['agentCodexReasoningEffort'] ?? d.settings.agentCodexReasoningEffort,
      },
    };
  } catch {
    return null;
  }
}

/** Normalize persisted metadata and discard runtime-only fields. */
export function rehydrateSessionMeta(persisted: unknown): AgentSessionMeta {
  const own = (persisted as { sessionMeta?: AgentSessionMeta } | null | undefined)?.sessionMeta;
  const d = DEFAULT_AGENT_SESSION_META;
  const base: AgentSessionMeta = own && typeof own === 'object'
    ? {
        ...d,
        ...own,
        threadLists: d.threadLists,
        lastRunningRunsReconciledAt: d.lastRunningRunsReconciledAt,
        settings: { ...d.settings, ...(own.settings ?? {}) },
      }
    : migrateChatPersistToSessionMeta() ?? d;

  const normalizedTypeKey = normalizeAgentTypeKey(base.activeAgentTypeKey);
  base.activeAgentTypeKey = isAgentTypeSelectable(normalizedTypeKey)
    ? normalizedTypeKey
    : DEFAULT_AGENT_TYPE_KEY;
  base.settings.agentPermissionMode = normalizeCodexPermissionMode(
    base.settings.agentPermissionMode,
  );
  try {
    localStorage.removeItem(STORAGE_KEYS.CHAT);
  } catch {
    // SSR / restricted storage: persistence middleware handles the same case.
  }
  return base;
}
