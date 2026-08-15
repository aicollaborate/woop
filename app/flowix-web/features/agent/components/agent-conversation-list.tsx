'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import { normalizeBackendInstance } from '@features/agent/store/conversation-slice';
import { useDocumentStore } from '@features/document';
import { useMemoStore } from '@features/memo';
import { agentClient } from '@features/agent/store/agent-client';
import {
  isAgentConversationRunning,
  useConversationRunIndex,
} from '@features/agent/store/conversation-run-index';
import { AGENT_TYPES, getAgentType, isAgentTypeSelectable } from '@/lib/agent-types';
import type { AgentTypeKey } from '@/types/agent';
import { formatTimeAgo } from '@/lib/format-time-ago';
import { createLogger } from '@/lib/logger';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';

/**
 * The "Conversations" navigation view. It deliberately lists conversation
 * instances rather than notes: one note may contain more than one agent thread.
 * A row opens the dedicated right-panel conversation surface directly; the
 * source note is retained only as conversation metadata/context, not navigated.
 */
type ConversationGroupKey = 'today' | 'yesterday' | 'last7Days' | 'earlier';

// 日期分组标题文案 key ── 用 as const 让每个 value 都是字面量 I18nKey, 直接喂 t()
// 无需 cast。分组顺序固定: 今天 → 昨天 → 最近 7 天 → 更早。
const CONVERSATION_GROUP_LABEL_KEY = {
  today: 'document.agent.group.today',
  yesterday: 'document.agent.group.yesterday',
  last7Days: 'document.agent.group.last7Days',
  earlier: 'document.agent.group.earlier',
} as const;
const logger = createLogger('agent-conversation-list');

export function AgentConversationList() {
  const { t } = useI18n();
  const instances = useAgentSessionStore((state) => state.conversationRegistry.instances);
  const currentNotebookId = useMemoStore((state) => state.selectedNotebook?.id ?? null);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [persistedInstances, setPersistedInstances] = useState<Record<string, AgentConversationInstance>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [filterType, setFilterType] = useState<AgentTypeKey | null>(null);

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
        logger.error('failed to load conversations', { error });
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

  // 运行态来自 canonical thread projections；使用合并后的列表作为索引输入，
  // 这样后端持久化列表中的对话也能在运行时显示外框 loading。
  const conversationInstances = useMemo(
    () => Object.fromEntries(conversations.map((instance) => [instance.instanceId, instance])),
    [conversations],
  );
  const conversationRunIndex = useConversationRunIndex(conversationInstances);

  // 按当前笔记本圈定对话列表 —— 与中间列 MemoList 同口径。归属当前笔记本的对话
  // 全部展示；没有笔记本归属 (source.notebookId 为空，例如从独立对话面板发起，或
  // 本变更之前创建的历史对话) 的对话始终展示，避免它们在任何笔记本下都消失。
  // 未选中笔记本时退化为全量。
  const scopedConversations = useMemo(() => {
    if (!currentNotebookId) return conversations;
    return conversations.filter((instance) => {
      const notebookId = instance.source?.notebookId;
      return !notebookId || notebookId === currentNotebookId;
    });
  }, [conversations, currentNotebookId]);

  // 筛选条只展示"已激活"的 agent 类型 ── 即当前对话列表里真实存在 (count > 0)
  // 且可选用 (非 coming-soon) 的 agent。按 AGENT_TYPES 定义顺序排列，保证图标
  // 顺序稳定。少于 2 种时不渲染筛选条：单一类型没有可筛选的空间，一个按下后
  // 毫无视觉变化的按钮只会让用户困惑。
  const activeAgentTypes = useMemo(() => {
    const counts = new Map<AgentTypeKey, number>();
    for (const instance of scopedConversations) {
      if (!isAgentTypeSelectable(instance.agentType)) continue;
      counts.set(instance.agentType, (counts.get(instance.agentType) ?? 0) + 1);
    }
    return AGENT_TYPES
      .filter((type) => counts.has(type.key))
      .map((type) => ({ type, count: counts.get(type.key) ?? 0 }));
  }, [scopedConversations]);

  // 对话可能在筛选期间变成空集 (例如全部删除) ── 若当前筛选的类型已不再激活，
  // 自动回退到"全部"，避免列表卡在空状态。
  const effectiveFilter: AgentTypeKey | null =
    filterType && activeAgentTypes.some((entry) => entry.type.key === filterType)
      ? filterType
      : null;

  const visibleConversations = effectiveFilter
    ? scopedConversations.filter((instance) => instance.agentType === effectiveFilter)
    : scopedConversations;

  // 按日期分桶 (基于 updatedAt)。visibleConversations 已按 updatedAt DESC 排好,
  // 逐条归入桶即保持桶内顺序; 只渲染非空桶, 桶间用 mt-3 分隔。
  const conversationGroups = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayMs = 24 * 60 * 60 * 1000;
    const startOfYesterday = startOfToday - dayMs;
    const startOf7Days = startOfToday - 7 * dayMs;
    const buckets: Record<ConversationGroupKey, AgentConversationInstance[]> = {
      today: [],
      yesterday: [],
      last7Days: [],
      earlier: [],
    };
    for (const instance of visibleConversations) {
      const ts = instance.updatedAt;
      if (ts >= startOfToday) buckets.today.push(instance);
      else if (ts >= startOfYesterday) buckets.yesterday.push(instance);
      else if (ts >= startOf7Days) buckets.last7Days.push(instance);
      else buckets.earlier.push(instance);
    }
    return (['today', 'yesterday', 'last7Days', 'earlier'] as ConversationGroupKey[])
      .map((key) => ({ key, items: buckets[key] }))
      .filter((group) => group.items.length > 0);
  }, [visibleConversations]);

  const displayName = (type: (typeof AGENT_TYPES)[number]): string =>
    type.nameKey ? t(type.nameKey as Parameters<typeof t>[0]) : type.name;

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
      {/* 标题行 ── 与 MemoList / FolderFileTree 共用同一套中间列头部结构:
          左侧标题占据剩余空间, 右侧保留本列表自己的筛选控件。 */}
      <div className="flex items-center justify-between pl-2 pr-3.5 pb-2 gap-2">
        <div className="min-w-0 flex-1">
          <span className="block min-w-0 truncate py-0.5 pl-1 pr-2 text-[15px] font-medium text-[var(--foreground)]">
            {t('document.agent.conversationsTitle')}
          </span>
        </div>
        {activeAgentTypes.length >= 2 && (
          <div
            className="flex items-center gap-1 shrink-0"
            role="group"
            aria-label={t('document.agent.filterByAgent')}
          >
            {activeAgentTypes.map(({ type, count }) => {
              const active = effectiveFilter === type.key;
              const label = t('document.agent.filterByAgentCount', {
                name: displayName(type),
                count,
              });
              return (
                <button
                  key={type.key}
                  type="button"
                  aria-pressed={active}
                  title={label}
                  aria-label={label}
                  onClick={() => setFilterType((prev) => (prev === type.key ? null : type.key))}
                  className={cn(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors',
                    active
                      ? 'border-transparent bg-[var(--muted)]'
                      : 'border-[var(--border)] opacity-60 hover:opacity-100',
                  )}
                >
                  <img src={type.icon} alt="" className="h-full w-full object-contain" draggable={false} />
                </button>
              );
            })}
          </div>
        )}
      </div>
      <OverlayScrollbar className="min-h-0 flex-1" scrollerClassName="flex h-full flex-col overflow-y-auto px-2 py-2">
        {isLoading ? null : scopedConversations.length === 0 ? (
          <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-[var(--muted-foreground)]">
            {t('status.agent.noConversations')}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {conversationGroups.map((group, index) => (
              <div key={group.key} className={cn('flex flex-col gap-0.5', index > 0 && 'mt-3')}>
                <h3 className="px-2 text-xs font-medium text-[var(--muted-foreground)]">
                  {t(CONVERSATION_GROUP_LABEL_KEY[group.key])}
                </h3>
                {group.items.map((instance) => {
                  const agent = getAgentType(instance.agentType);
                  const canOpen = Boolean(instance.threadId);
                  const selected = instance.instanceId === selectedInstanceId;
                  const running = isAgentConversationRunning(instance, conversationRunIndex);
                  return (
                    <button
                      key={instance.instanceId}
                      type="button"
                      disabled={!canOpen}
                      onClick={() => void revealConversation(instance)}
                      title={canOpen ? t('status.agent.openRun') : t('status.agent.originUnavailable')}
                      className={cn(
                        'flex h-9 w-full items-center gap-2 rounded-lg px-2 py-1 text-left transition-colors',
                        selected
                          ? 'bg-[var(--muted)] text-[var(--foreground)]'
                          : 'text-[var(--foreground)] hover:bg-[var(--muted)]',
                        !canOpen && 'cursor-not-allowed opacity-55',
                      )}
                    >
                      <span className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-[var(--border)]',
                        running && 'agent-conversation-list__icon--running',
                      )}>
                        <img src={agent.icon} alt="" className="h-3 w-3 object-contain" draggable={false} />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-normal">
                        {instance.title?.trim() || t('common.untitled')}
                      </span>
                      <time className="shrink-0 text-xs text-[var(--muted-foreground)]" dateTime={new Date(instance.updatedAt).toISOString()}>
                        {formatTimeAgo(instance.updatedAt, t)}
                      </time>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </OverlayScrollbar>
    </section>
  );
}
