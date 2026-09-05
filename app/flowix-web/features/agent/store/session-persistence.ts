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

const LEGACY_AGENT_TITLE_KEYS = new Set([
  'codex',
  'claude',
  'gemini',
  'hermes',
  'openclaw',
  'opencode',
  'deepseek-harness',
]);

/** Move the old AgentTypeKey-wide title slots onto the active product thread. */
function normalizeThreadTitles(
  value: unknown,
  activeThreadIds: AgentSessionMeta['activeThreadIds'],
): AgentSessionMeta['currentThreadTitles'] {
  if (!value || typeof value !== 'object') return {};
  const next: AgentSessionMeta['currentThreadTitles'] = {};
  for (const [key, title] of Object.entries(value as Record<string, unknown>)) {
    if (typeof title !== 'string') continue;
    if (LEGACY_AGENT_TITLE_KEYS.has(key)) {
      const activeThreadId = activeThreadIds[key as keyof typeof activeThreadIds];
      if (activeThreadId) next[activeThreadId] = title;
      continue;
    }
    next[key] = title;
  }
  return next;
}

/** Migrate the legacy flat chat-store payload into the session metadata slice. */
function migrateChatPersistToSessionMeta(): AgentSessionMeta | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.CHAT);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: Record<string, unknown> };
    const old = parsed.state;
    if (!old || typeof old !== 'object') return null;
    const d = DEFAULT_AGENT_SESSION_META;
    const activeThreadIds =
      old.activeThreadIds as AgentSessionMeta['activeThreadIds'] ?? d.activeThreadIds;
    return {
      ...d,
      activeThreadIds,
      activeAgentTypeKey: old.activeAgentTypeKey as AgentSessionMeta['activeAgentTypeKey'] ?? d.activeAgentTypeKey,
      threadTypes: old.threadTypes as AgentSessionMeta['threadTypes'] ?? d.threadTypes,
      currentThreadTitles: normalizeThreadTitles(old.currentThreadTitles, activeThreadIds),
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
  base.currentThreadTitles = normalizeThreadTitles(
    base.currentThreadTitles,
    base.activeThreadIds,
  );
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
