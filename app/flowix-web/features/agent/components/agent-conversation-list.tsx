'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import { normalizeBackendInstance } from '@features/agent/store/conversation-slice';
import { useDocumentStore } from '@features/document';
import { agentClient } from '@features/agent/store/agent-client';
import { getAgentType } from '@/lib/agent-types';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';

function formatConversationTime(timestamp: number, language: 'zh-CN' | 'en-US'): string {
  return new Intl.DateTimeFormat(language === 'zh-CN' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

/**
 * The "Conversations" navigation view. It deliberately lists conversation
 * instances rather than notes: one note may contain more than one agent thread.
 * A row opens the dedicated right-panel conversation surface directly; the
 * source note is retained only as conversation metadata/context, not navigated.
 */
export function AgentConversationList() {
  const { language, t } = useI18n();
  const instances = useAgentSessionStore((state) => state.conversationRegistry.instances);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [persistedInstances, setPersistedInstances] = useState<Record<string, AgentConversationInstance>>({});
  const [isLoading, setIsLoading] = useState(true);

  // The list owns a durable snapshot from the backend. Zustand remains useful
  // for live rows created in this window, but a webview reload must never turn
  // the persisted history into an empty list while the shared store rehydrates.
  useEffect(() => {
    let active = true;
    void agentClient.listConversationInstances()
      .then((items) => {
        if (!active) return;
        setPersistedInstances(Object.fromEntries(
          items.map((instance) => {
            const normalized = normalizeBackendInstance(instance);
            return [normalized.instanceId, normalized];
          }),
        ));
      })
      .catch((error) => {
        console.error('[AgentConversationList] Failed to load conversations:', error);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const conversations = useMemo(() => {
    const merged = { ...persistedInstances };
    for (const instance of Object.values(instances)) {
      const persisted = merged[instance.instanceId];
      if (!persisted || instance.updatedAt >= persisted.updatedAt) {
        merged[instance.instanceId] = instance;
      }
    }
    return Object.values(merged).sort((a, b) => b.updatedAt - a.updatedAt);
  }, [instances, persistedInstances]);

  const revealConversation = useCallback(async (instance: AgentConversationInstance) => {
    setSelectedInstanceId(instance.instanceId);

    // The durable list snapshot may arrive before the Zustand session store
    // hydrates. Install this exact persisted instance without rewriting it so
    // the right panel can immediately resolve its runtime configuration.
    useAgentSessionStore.getState().setConversationRegistry((registry) => ({
      ...registry,
      instances: {
        ...registry.instances,
        [instance.instanceId]: instance,
      },
    }));

    if (instance.threadId) {
      useAgentSessionStore.getState().setSessionMeta((meta) => ({
        ...meta,
        activeThreadIds: {
          ...meta.activeThreadIds,
          [instance.agentType]: instance.threadId!,
        },
        activeAgentTypeKey: instance.agentType,
      }));
    }

    await useDocumentStore.getState().openAgentConversation(instance.instanceId);
  }, []);

  return (
    <section className="flex h-full min-h-0 flex-1 flex-col bg-[var(--card)]" aria-label={t('document.agent.conversationsTitle')}>
      <div className="flex h-8 shrink-0 items-center px-4">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">
          {t('document.agent.conversationsTitle')}
        </h2>
      </div>
      <OverlayScrollbar className="min-h-0 flex-1" scrollerClassName="flex h-full flex-col overflow-y-auto px-2 py-2">
        {isLoading ? null : conversations.length === 0 ? (
          <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-[var(--muted-foreground)]">
            {t('status.agent.noConversations')}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {conversations.map((instance) => {
              const agent = getAgentType(instance.agentType);
              const canOpen = Boolean(instance.threadId);
              const selected = instance.instanceId === selectedInstanceId;
              return (
                <button
                  key={instance.instanceId}
                  type="button"
                  disabled={!canOpen}
                  onClick={() => void revealConversation(instance)}
                  title={canOpen ? t('status.agent.openRun') : t('status.agent.originUnavailable')}
                  className={cn(
                    'flex min-h-10 w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors',
                    selected
                      ? 'bg-[var(--muted)] text-[var(--foreground)]'
                      : 'text-[var(--foreground)] hover:bg-[var(--muted)]',
                    !canOpen && 'cursor-not-allowed opacity-55',
                  )}
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[var(--border)]">
                    <img src={agent.icon} alt="" className="h-full w-full object-contain" draggable={false} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {instance.title?.trim() || t('common.untitled')}
                  </span>
                  <time className="shrink-0 text-xs text-[var(--muted-foreground)]" dateTime={new Date(instance.updatedAt).toISOString()}>
                    {formatConversationTime(instance.updatedAt, language)}
                  </time>
                </button>
              );
            })}
          </div>
        )}
      </OverlayScrollbar>
    </section>
  );
}
