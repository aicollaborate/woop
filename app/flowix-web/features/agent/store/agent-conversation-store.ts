import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { ChatMessage } from "@/types";
import type {
  AgentTypeKey,
  RuntimeConfig,
  RuntimeConfigPatch,
} from "@/types/agent";
import type {
  AgentConversationInstance as BackendAgentConversationInstance,
} from "@platform/tauri/client";
import { stripSystemBlock } from "@features/agent/message";
import { agentClient } from "@features/agent/store/agent-client";
import { useAgentSessionStore } from "@features/agent/store/agent-session-store";
import type { LiveMessageState } from "@features/agent/store/chunk-result";
import type { ThreadsMap } from "@features/agent/store/thread-runtime-state";
import {
  filterRenderableHistoryMessages,
  getHistoryPage,
  getInitialThreadHistory,
  HISTORY_PAGE_SIZE,
  mergeLiveMessagesIntoRenderableMessages,
  mergeHistoricalMessages,
  prependHistoricalMessages,
  trySwapLastLiveMessage,
} from "@features/agent/store/thread-history";

export type AgentConversationSource = {
  kind: "thread-card";
  documentPath?: string | null;
  memoId?: string | null;
};

export interface AgentConversationRole {
  memoId?: string | null;
  name?: string | null;
}

export interface AgentConversationInstance {
  instanceId: string;
  agentType: AgentTypeKey;
  title: string;
  threadId: string | null;
  runtimeConfig?: RuntimeConfig | null;
  /** Observability only. The backend is the sole writer and runtime authority. */
  readonly frozenCwd?: string | null;
  source: AgentConversationSource;
  role?: AgentConversationRole | null;
  createdAt: number;
  updatedAt: number;
}

export interface AgentConversationMessageState extends LiveMessageState {
  oldestSequence: number | null;
  hasMoreHistory: boolean;
  loadingInitial: boolean;
  loadingMore: boolean;
}

export interface CreateAgentConversationInstanceInput {
  agentType: AgentTypeKey;
  title: string;
  threadId?: string | null;
  runtimeConfig?: RuntimeConfig | null;
  source: AgentConversationSource;
  role?: AgentConversationRole;
}

export interface AgentConversationStore {
  instances: Record<string, AgentConversationInstance>;
  messageStates: Record<string, AgentConversationMessageState>;
  hydrateFromBackend: () => Promise<void>;
  createInstance: (
    input: CreateAgentConversationInstanceInput,
  ) => AgentConversationInstance;
  upsertInstance: (
    instanceId: string,
    patch: Partial<Omit<AgentConversationInstance, "instanceId" | "createdAt">>,
  ) => AgentConversationInstance;
  setRuntimeConfig: (instanceId: string, patch: RuntimeConfigPatch) => void;
  getInstance: (instanceId: string | null | undefined) => AgentConversationInstance | null;
  updateThread: (
    instanceId: string,
    patch: {
      threadId?: string | null;
      agentType?: AgentTypeKey;
    },
  ) => void;
  renameInstance: (instanceId: string, title: string) => void;
  removeInstance: (instanceId: string) => void;
  removeInstancesForThread: (threadId: string) => void;
  resolveSessionByThreadId: (
    localThreadId: string,
    sessionId: string,
    agentType: AgentTypeKey,
  ) => string | null;
  findByThreadId: (threadId: string) => AgentConversationInstance | null;
  getMessageState: (
    threadId: string | null | undefined,
  ) => AgentConversationMessageState | null;
  mergeMessages: (
    agentType: AgentTypeKey,
    threadId: string,
    messages: ChatMessage[],
  ) => void;
  syncRenderableMessages: (
    agentType: AgentTypeKey,
    threadId: string,
    messages: ChatMessage[],
  ) => void;
  syncLiveMessageState: (
    agentType: AgentTypeKey,
    threadId: string,
    liveState: LiveMessageState,
  ) => void;
  resetMessageStates: (threadIds: string[]) => void;
  loadMessages: (agentType: AgentTypeKey, threadId: string) => Promise<void>;
  loadMoreMessages: (agentType: AgentTypeKey, threadId: string) => Promise<void>;
}

let instanceSeq = 0;

function createInstanceId(now = Date.now()): string {
  instanceSeq += 1;
  return `agent-inst-${now}-${instanceSeq}`;
}

function touch<T extends AgentConversationInstance>(instance: T): T {
  return { ...instance, updatedAt: Date.now() };
}

function matchesThread(instance: AgentConversationInstance, threadId: string): boolean {
  return instance.threadId === threadId;
}

function emptyMessageState(): AgentConversationMessageState {
  return {
    messages: [],
    pendingAssistantId: null,
    pendingReasoningId: null,
    oldestSequence: null,
    hasMoreHistory: false,
    loadingInitial: false,
    loadingMore: false,
  };
}

function parseRuntimeConfigSnapshot(
  value: BackendAgentConversationInstance["runtimeConfig"] | RuntimeConfig | null | undefined,
): RuntimeConfig | null {
  if (!value) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as RuntimeConfig;
  } catch {
    return null;
  }
}

function serializeRuntimeConfigSnapshot(
  value: RuntimeConfig | null | undefined,
): string | null {
  if (!value || Object.keys(value).length === 0) return null;
  return JSON.stringify(value);
}

function mergeRuntimeConfig(
  current: RuntimeConfig | null | undefined,
  patch: RuntimeConfigPatch,
): RuntimeConfig {
  const merged: RuntimeConfig = { ...(current ?? {}) };
  for (const key of Object.keys(patch) as (keyof RuntimeConfig)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}

function normalizeBackendInstance(
  instance: AgentConversationInstance | BackendAgentConversationInstance,
): AgentConversationInstance {
  return {
    ...instance,
    runtimeConfig: parseRuntimeConfigSnapshot(instance.runtimeConfig),
    role: instance.role ?? undefined,
  };
}

function toBackendInstance(
  instance: AgentConversationInstance,
): BackendAgentConversationInstance {
  const { frozenCwd: _backendOwnedCwd, ...frontendOwned } = instance;
  return {
    ...frontendOwned,
    runtimeConfig: serializeRuntimeConfigSnapshot(instance.runtimeConfig),
  };
}

function normalizeConversationTitle(title: string | null | undefined): string {
  return stripSystemBlock(title ?? "").replace(/\s+/g, " ").trim();
}

const instanceWriteQueues = new Map<string, Promise<void>>();


function enqueueInstanceWrite(
  instanceId: string,
  task: () => Promise<void>,
  label: string,
): void {
  const previous = instanceWriteQueues.get(instanceId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(task)
    .catch((err) => {
      console.error(`[AgentConversation] Failed to ${label}:`, err);
    })
    .finally(() => {
      if (instanceWriteQueues.get(instanceId) === next) {
        instanceWriteQueues.delete(instanceId);
      }
    });
  instanceWriteQueues.set(instanceId, next);
}

function persistInstance(instance: AgentConversationInstance): void {
  enqueueInstanceWrite(
    instance.instanceId,
    () => agentClient.upsertConversationInstance(toBackendInstance(instance)).then(() => undefined),
    "persist instance",
  );
}

function deletePersistedInstance(instanceId: string): void {
  enqueueInstanceWrite(
    instanceId,
    () => agentClient.deleteConversationInstance(instanceId).then(() => undefined),
    "delete instance",
  );
}

function deletePersistedInstancesForThread(threadId: string): void {
  void agentClient.deleteConversationInstancesForThread(threadId).catch((err) => {
    console.error("[AgentConversation] Failed to delete thread instances:", err);
  });
}

export const useAgentConversationStore = create<AgentConversationStore>()(
  subscribeWithSelector(
    (set, get) => ({
      instances: {},
      messageStates: {},

      hydrateFromBackend: async () => {
        try {
          const instances = await agentClient.listConversationInstances();
          set((state) => {
            const next = { ...state.instances };
            for (const instance of instances) {
              const normalized = normalizeBackendInstance(instance);
              const existing = next[normalized.instanceId];
              if (!existing || normalized.updatedAt >= existing.updatedAt) {
                next[normalized.instanceId] = normalized;
              }
            }
            return { instances: next };
          });
        } catch (err) {
          console.error("[AgentConversation] Failed to hydrate instances:", err);
        }
      },

      createInstance: (input) => {
        const now = Date.now();
        const instance: AgentConversationInstance = {
          instanceId: createInstanceId(now),
          agentType: input.agentType,
          title: normalizeConversationTitle(input.title),
          threadId: input.threadId ?? null,
          runtimeConfig: input.runtimeConfig ?? null,
          source: input.source,
          role: input.role,
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({
          instances: {
            ...state.instances,
            [instance.instanceId]: instance,
          },
        }));
        persistInstance(instance);
        return instance;
      },

      upsertInstance: (instanceId, patch) => {
        const now = Date.now();
        let nextInstance!: AgentConversationInstance;
        set((state) => {
          const existing = state.instances[instanceId];
          nextInstance = {
            instanceId,
            agentType: patch.agentType ?? existing?.agentType ?? "flowix",
            title:
              patch.title !== undefined
                ? normalizeConversationTitle(patch.title)
                : existing?.title ?? "",
            threadId: patch.threadId ?? existing?.threadId ?? null,
            runtimeConfig:
              patch.runtimeConfig !== undefined
                ? patch.runtimeConfig
                : existing?.runtimeConfig ?? null,
            source: patch.source ?? existing?.source ?? { kind: "thread-card" },
            role: patch.role ?? existing?.role,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          };
          return {
            instances: {
              ...state.instances,
              [instanceId]: nextInstance!,
            },
          };
        });
        persistInstance(nextInstance!);
        return nextInstance!;
      },

      setRuntimeConfig: (instanceId, patch) => {
        let nextInstance: AgentConversationInstance | null = null;
        set((state) => {
          const existing = state.instances[instanceId];
          if (!existing) return state;
          const mergedConfig = mergeRuntimeConfig(
            existing.runtimeConfig,
            patch,
          );
          nextInstance = touch({
            ...existing,
            runtimeConfig: mergedConfig,
          });
          return {
            instances: {
              ...state.instances,
              [instanceId]: nextInstance!,
            },
          };
        });
        if (nextInstance) persistInstance(nextInstance);
      },


      getInstance: (instanceId) =>
        instanceId ? get().instances[instanceId] ?? null : null,

      updateThread: (instanceId, patch) => {
        let nextInstance: AgentConversationInstance | null = null;
        set((state) => {
          const existing = state.instances[instanceId];
          if (!existing) return state;
          nextInstance = touch({
            ...existing,
            agentType: patch.agentType ?? existing.agentType,
            threadId:
              patch.threadId !== undefined ? patch.threadId : existing.threadId,
          });
          return {
            instances: {
              ...state.instances,
              [instanceId]: nextInstance!,
            },
          };
        });
        if (nextInstance) persistInstance(nextInstance);
      },

      renameInstance: (instanceId, title) => {
        const nextTitle = normalizeConversationTitle(title);
        if (!nextTitle) return;
        let nextInstance: AgentConversationInstance | null = null;
        set((state) => {
          const existing = state.instances[instanceId];
          if (!existing || existing.title === nextTitle) return state;
          nextInstance = touch({ ...existing, title: nextTitle });
          return {
            instances: {
              ...state.instances,
              [instanceId]: nextInstance!,
            },
          };
        });
        if (nextInstance) persistInstance(nextInstance);
      },

      removeInstance: (instanceId) => {
        set((state) => {
          if (!state.instances[instanceId]) return state;
          const { [instanceId]: _removed, ...instances } = state.instances;
          return { instances };
        });
        deletePersistedInstance(instanceId);
      },

      removeInstancesForThread: (threadId) => {
        const removedIds: string[] = [];
        set((state) => {
          const instances = Object.fromEntries(
            Object.entries(state.instances).filter(([instanceId, instance]) => {
              const remove = matchesThread(instance, threadId);
              if (remove) removedIds.push(instanceId);
              return !remove;
            }),
          );
          if (
            Object.keys(instances).length === Object.keys(state.instances).length &&
            !state.messageStates[threadId]
          ) {
            return state;
          }
          const { [threadId]: _removedMessages, ...messageStates } =
            state.messageStates;
          return { instances, messageStates };
        });
        for (const instanceId of removedIds) {
          deletePersistedInstance(instanceId);
        }
        deletePersistedInstancesForThread(threadId);
      },

      resolveSessionByThreadId: (localThreadId, sessionId, agentType) => {
        const instance = get().findByThreadId(localThreadId);
        if (instance) {
          get().updateThread(instance.instanceId, {
            agentType,
            threadId: sessionId,
          });
        }
        set((state) => {
          const localMessages = state.messageStates[localThreadId];
          if (!localMessages) return state;
          const existing = state.messageStates[sessionId] ?? emptyMessageState();
          const { [localThreadId]: _removed, ...rest } = state.messageStates;
          return {
            messageStates: {
              ...rest,
              [sessionId]: {
                ...existing,
                messages: mergeHistoricalMessages(
                  existing.messages,
                  localMessages.messages,
                  agentType,
                ),
                pendingAssistantId:
                  existing.pendingAssistantId ?? localMessages.pendingAssistantId,
                pendingReasoningId:
                  existing.pendingReasoningId ?? localMessages.pendingReasoningId,
                oldestSequence: existing.oldestSequence ?? localMessages.oldestSequence,
                hasMoreHistory:
                  existing.hasMoreHistory || localMessages.hasMoreHistory,
                loadingInitial:
                  existing.loadingInitial || localMessages.loadingInitial,
                loadingMore: existing.loadingMore || localMessages.loadingMore,
              },
            },
          };
        });
        return instance?.instanceId ?? null;
      },

      findByThreadId: (threadId) =>
        Object.values(get().instances).find((instance) =>
          matchesThread(instance, threadId),
        ) ?? null,

      getMessageState: (threadId) =>
        threadId ? get().messageStates[threadId] ?? null : null,

      mergeMessages: (agentType, threadId, messages) => {
        const renderable = filterRenderableHistoryMessages(messages);
        if (renderable.length === 0) return;
        set((state) => {
          const current = state.messageStates[threadId] ?? emptyMessageState();
          const merged = mergeHistoricalMessages(
            current.messages,
            renderable,
            agentType,
          );
          if (merged === current.messages) return state;
          return {
            messageStates: {
              ...state.messageStates,
              [threadId]: {
                ...current,
                messages: merged,
              },
            },
          };
        });
      },

      syncRenderableMessages: (agentType, threadId, messages) => {
        const renderable = filterRenderableHistoryMessages(messages);
        if (renderable.length === 0) return;
        set((state) => {
          const current = state.messageStates[threadId] ?? emptyMessageState();
          const merged = mergeLiveMessagesIntoRenderableMessages(
            current.messages,
            renderable,
            agentType,
          );
          if (merged === current.messages) return state;
          return {
            messageStates: {
              ...state.messageStates,
              [threadId]: {
                ...current,
                messages: merged,
              },
            },
          };
        });
      },

      syncLiveMessageState: (agentType, threadId, liveState) => {
        const renderable = filterRenderableHistoryMessages(liveState.messages);
        set((state) => {
          const current = state.messageStates[threadId] ?? emptyMessageState();
          // 流式 fast path: 末条 assistant/reasoning/end 内容变化时直接 swap,
          // 跳过全量 merge 的 fingerprint + sort (O(N·L) -> O(N) 引用比较)。
          // 未命中 (结构变化 / 末条非文本角色) 回退原 merge, 保证去重与 hydrate 正确。
          const swapped = trySwapLastLiveMessage(current.messages, renderable);
          const merged =
            swapped ??
            (renderable.length > 0
              ? mergeLiveMessagesIntoRenderableMessages(
                  current.messages,
                  renderable,
                  agentType,
                )
              : current.messages);
          if (
            merged === current.messages &&
            current.pendingAssistantId === liveState.pendingAssistantId &&
            current.pendingReasoningId === liveState.pendingReasoningId
          ) {
            return state;
          }
          return {
            messageStates: {
              ...state.messageStates,
              [threadId]: {
                ...current,
                messages: merged,
                pendingAssistantId: liveState.pendingAssistantId,
                pendingReasoningId: liveState.pendingReasoningId,
              },
            },
          };
        });
      },

      resetMessageStates: (threadIds) => {
        const uniqueThreadIds = Array.from(new Set(threadIds.filter(Boolean)));
        if (uniqueThreadIds.length === 0) return;
        set((state) => {
          const messageStates = { ...state.messageStates };
          for (const threadId of uniqueThreadIds) {
            messageStates[threadId] = emptyMessageState();
          }
          return { messageStates };
        });
      },

      loadMessages: async (agentType, threadId) => {
        // Phase 5 (2026-08-03): 真源是 useAgentSessionStore.threadProjections,
        // conv-store.messageStates 是 mirror. 写 threadProjections, mirror
        // 自动同步 messageStates ── 这里只写真源, 不再直接 set conv-store.
        const session = useAgentSessionStore.getState();
        if (
          session.threadProjections[threadId]?.pagination.loadingInitial
        ) {
          return;
        }
        session.setThreadProjection(threadId, (p) => ({
          ...p,
          pagination: { ...p.pagination, loadingInitial: true },
        }));

        try {
          const page = await getInitialThreadHistory(
            agentType,
            threadId,
            HISTORY_PAGE_SIZE,
          );
          const messages = filterRenderableHistoryMessages(page.messages);
          session.setThreadProjection(threadId, (p) => {
            const merged = mergeHistoricalMessages(
              p.messages,
              messages,
              agentType,
            );
            return {
              ...p,
              messages: merged,
              pagination: {
                oldestSequence: page.oldestSequence,
                hasMoreHistory: page.hasMore,
                loadingInitial: false,
                loadingMore: false,
              },
            };
          });
        } catch (err) {
          console.error("[AgentConversation] Failed to load messages:", err);
          session.setThreadProjection(threadId, (p) => ({
            ...p,
            pagination: { ...p.pagination, loadingInitial: false },
          }));
        }
      },

      loadMoreMessages: async (agentType, threadId) => {
        // Phase 5: 写真源 session-store.threadProjections, mirror 同步
        // conv-store.messageStates. 避免 session-store ↔ conv-store 循环.
        const session = useAgentSessionStore.getState();
        const current = session.threadProjections[threadId];
        if (
          !current ||
          current.pagination.loadingMore ||
          !current.pagination.hasMoreHistory ||
          current.pagination.oldestSequence === null
        ) {
          return;
        }
        session.setThreadProjection(threadId, (p) => ({
          ...p,
          pagination: { ...p.pagination, loadingMore: true },
        }));

        try {
          const page = await getHistoryPage(
            agentType,
            threadId,
            current.pagination.oldestSequence,
            HISTORY_PAGE_SIZE,
          );
          const messages = filterRenderableHistoryMessages(page.messages);
          session.setThreadProjection(threadId, (p) => {
            const merged = prependHistoricalMessages(
              p.messages,
              messages,
              agentType,
            );
            return {
              ...p,
              messages: merged,
              pagination: {
                oldestSequence:
                  page.oldestSequence ?? p.pagination.oldestSequence,
                hasMoreHistory: page.hasMore,
                loadingInitial: false,
                loadingMore: false,
              },
            };
          });
        } catch (err) {
          console.error("[AgentConversation] Failed to load more messages:", err);
          session.setThreadProjection(threadId, (p) => ({
            ...p,
            pagination: { ...p.pagination, loadingMore: false },
          }));
        }
      },
    }),
  ),
);

// Phase 4 (2026-08-02): 注册 conv-store getState 到 session-store, 让
// session-store 的委托 actions (loadMessages / renameInstance / removeInstance
// 等) 可以同步调用本 store. 避免循环依赖: session-store 不静态 import
// 本模块, 而是通过 late binding 获取引用.
import { _bindConvStore } from "@features/agent/store/agent-session-store";
_bindConvStore(() => useAgentConversationStore.getState());

export function selectAgentConversationRunStatus(
  instance: AgentConversationInstance | null | undefined,
  threadStates: ThreadsMap,
): "running" | "completed" | "failed" | "cancelled" | null {
  const threadId = instance?.threadId;
  if (!threadId) return null;
  const state = threadStates[threadId];
  if (!state) return null;
  const activeRun = state.activeRunId ? state.runs[state.activeRunId] : undefined;
  return activeRun?.status ?? state.lastRun?.status ?? null;
}

export function selectIsAgentConversationRunning(
  instance: AgentConversationInstance | null | undefined,
  threadStates: ThreadsMap,
): boolean {
  return selectAgentConversationRunStatus(instance, threadStates) === "running";
}

export function selectRunningAgentConversationInstances(
  state: Pick<AgentConversationStore, "instances">,
  threadStates: ThreadsMap,
): AgentConversationInstance[] {
  return Object.values(state.instances)
    .filter((instance) => selectIsAgentConversationRunning(instance, threadStates))
    .sort((a, b) => {
      const aRun = a.threadId ? threadStates[a.threadId]?.activeRunId : null;
      const bRun = b.threadId ? threadStates[b.threadId]?.activeRunId : null;
      const aStartedAt = a.threadId && aRun ? threadStates[a.threadId]?.runs[aRun]?.startedAt ?? 0 : 0;
      const bStartedAt = b.threadId && bRun ? threadStates[b.threadId]?.runs[bRun]?.startedAt ?? 0 : 0;
      return aStartedAt - bStartedAt;
    });
}

export function selectRunningAgentConversationThreadIds(
  state: Pick<AgentConversationStore, "instances">,
  threadStates: ThreadsMap,
): string[] {
  const threadIds = new Set<string>();
  for (const instance of selectRunningAgentConversationInstances(state, threadStates)) {
    if (instance.threadId) threadIds.add(instance.threadId);
  }
  return Array.from(threadIds);
}




