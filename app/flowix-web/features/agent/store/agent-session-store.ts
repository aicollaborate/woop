/**
 * `useAgentSessionStore` ── agent session 的单一真源.
 *
 * 三 sub-projection: sessionMeta (localStorage) / conversationRegistry
 * (backend SQLite) / threadProjections (in-memory, 派生自 events).
 *
 * Phase 5 (2026-08-03): 所有 action 方法在本 store 上可用. 复杂 action
 * (sendMessageToThread / loadThread / deleteThread 等) 委托到老 store
 * 实现 (chat-store / agent-conversation-store), 老 store 已通过
 * setWithMetaMirror / setWithInstanceMirror / dispatch 写回本 store.
 * 简单 setter (bindThreadType / setActiveAgentTypeKey / setAgent* 等)
 * 直接在本 store 实现, 不经老 store.
 *
 * 完整方案: `/Users/rop/Desktop/Notes/开发任务管理/Agent 消息双写重构方案.md`
 */

import { create } from "zustand";
import { persist, subscribeWithSelector } from "zustand/middleware";
import type {
  AgentChunk,
  AgentCodexModel,
  AgentCodexReasoningEffort,
  AgentEvent,
  AgentPermissionMode,
  AgentTypeKey,
  RunInfo,
  RuntimeConfig,
  RuntimeConfigPatch,
} from "@/types/agent";
import type { ThreadListItem, ChatMessage } from "@/types";
import { agentClient } from "@features/agent/store/agent-client";
import { stripSystemBlock } from "@features/agent/message";
import type {
  AgentConversationInstance,
  AgentConversationMessageState,
  CreateAgentConversationInstanceInput,
} from "@features/agent/store/agent-conversation-store";
import type { AgentConversationInstance as BackendAgentConversationInstance } from "@platform/tauri/client";
import type { LiveMessageState } from "@features/agent/store/chunk-result";
import {
  emptyProjection,
  mergeThreadProjections,
  reduceProjection,
  type ThreadProjection,
} from "@features/agent/store/session-reducer";
import { STORAGE_KEYS } from "@/lib/constants";
import {
  DEFAULT_AGENT_TYPE_KEY,
  isAgentTypeSelectable,
  normalizeAgentTypeKey,
} from "@/lib/agent-types";
import { normalizeCodexPermissionMode } from "@features/agent/runtime/agent-runtime-spec";

// --------------------------------------------------------------------
// Types
// --------------------------------------------------------------------

export interface AgentSessionMeta {
  activeThreadIds: Partial<Record<AgentTypeKey, string | undefined>>;
  activeAgentTypeKey: AgentTypeKey;
  threadTypes: Record<string, AgentTypeKey>;
  threadLists: Partial<Record<AgentTypeKey, ThreadListItem[]>>;
  currentThreadTitles: Partial<Record<AgentTypeKey, string | undefined>>;
  externalSessionResolutions: Record<string, string>;
  lastRunningRunsReconciledAt: number | null;
  settings: {
    agentPermissionMode: AgentPermissionMode;
    agentCodexModel: AgentCodexModel;
    agentCodexReasoningEffort: AgentCodexReasoningEffort;
  };
}

export const DEFAULT_AGENT_SESSION_META: AgentSessionMeta = {
  activeThreadIds: {},
  activeAgentTypeKey: "flowix",
  threadTypes: {},
  threadLists: {},
  currentThreadTitles: {},
  externalSessionResolutions: {},
  lastRunningRunsReconciledAt: null,
  settings: {
    agentPermissionMode: "danger-full-access",
    agentCodexModel: "inherit",
    agentCodexReasoningEffort: "medium",
  },
};

export interface AgentConversationRegistry {
  instances: Record<string, AgentConversationInstance>;
}

const EMPTY_REGISTRY: AgentConversationRegistry = { instances: {} };

export interface AgentSessionStore {
  sessionMeta: AgentSessionMeta;
  conversationRegistry: AgentConversationRegistry;
  threadProjections: Record<string, ThreadProjection>;

  // 核心写入
  dispatch: (event: AgentEvent) => void;
  setSessionMeta: (updater: (meta: AgentSessionMeta) => AgentSessionMeta) => void;
  setConversationRegistry: (
    updater: (registry: AgentConversationRegistry) => AgentConversationRegistry,
  ) => void;
  setThreadProjection: (
    threadId: string,
    updater: (p: ThreadProjection) => ThreadProjection,
  ) => void;
  removeThreadProjection: (threadId: string) => void;
  resetThreadProjections: (threadIds: string[]) => void;

  // 简单 setter (直接实现, 不经老 store)
  setThreadList: (list: ThreadListItem[]) => void;
  setActiveThreadId: (threadId: string | undefined) => void;
  setActiveCodexThreadId: (threadId: string | undefined) => void;
  setActiveClaudeThreadId: (threadId: string | undefined) => void;
  setActiveAgentTypeKey: (typeKey: AgentTypeKey) => void;
  setActiveAgentThread: (typeKey: AgentTypeKey, threadId: string | undefined) => void;
  bindThreadType: (threadId: string, typeKey: AgentTypeKey) => void;
  setAgentPermissionMode: (mode: AgentPermissionMode) => void;
  setAgentCodexModel: (model: AgentCodexModel) => void;
  setAgentCodexReasoningEffort: (effort: AgentCodexReasoningEffort) => void;

  // 复杂 action (委托老 store, 动态 import 避免循环依赖)
  migrateThreadState: (fromThreadId: string, toThreadId: string, typeKey: AgentTypeKey) => void;
  loadThreadList: () => Promise<void>;
  loadThread: (threadId: string) => Promise<void>;
  loadCodexThreadList: () => Promise<void>;
  loadCodexThread: (threadId: string) => Promise<void>;
  loadClaudeThreadList: () => Promise<void>;
  loadClaudeThread: (threadId: string) => Promise<void>;
  loadHermesThreadList: () => Promise<void>;
  loadHermesThread: (threadId: string) => Promise<void>;
  loadAgentThread: (typeKey: AgentTypeKey, threadId: string) => Promise<void>;
  loadLocalAgentThreadList: (typeKey: AgentTypeKey) => Promise<void>;
  loadThreadCache: (threadId: string) => Promise<void>;
  loadMoreHistory: (typeKey: AgentTypeKey, threadId: string) => Promise<void>;
  deleteThread: (threadId: string) => Promise<void>;
  renameThread: (threadId: string, title: string, typeKey?: AgentTypeKey) => Promise<void>;
  renameAgentConversation: (input: {
    instanceId?: string | null;
    threadId?: string | null;
    title: string;
    typeKey?: AgentTypeKey;
  }) => Promise<void>;
  sendMessageToThread: (
    threadId: string,
    content: string,
    typeKey?: AgentTypeKey,
    options?: {
      instanceId?: string;
      conversationTitle?: string;
      currentNoteContent?: string;
      agentRoleMemoId?: string;
      agentRoleName?: string;
      isFirstMessage?: boolean;
      runtimeConfig?: RuntimeConfig | null;
      imagePaths?: string[];
      agentRoleBody?: string | null;
    },
  ) => Promise<void>;
  stopStream: () => Promise<void>;
  stopThreadRun: (threadId: string, runId?: string) => Promise<void>;
  dispatchAgentEvent: (event: AgentEvent) => void;
  flushAgentEventBuffer: () => void;
  dispatchAgentChunk: (chunk: AgentChunk) => void;
  reconcileRunningRunsFromSnapshot: (running: Record<string, RunInfo>) => void;
  reconcileRunningRuns: () => Promise<Record<string, RunInfo>>;

  // Instance actions (委托 conv-store, 同步 via late binding)
  hydrateFromBackend: () => Promise<void>;
  createInstance: (input: CreateAgentConversationInstanceInput) => AgentConversationInstance;
  upsertInstance: (
    instanceId: string,
    patch: Partial<Omit<AgentConversationInstance, "instanceId" | "createdAt">>,
  ) => AgentConversationInstance;
  setRuntimeConfig: (instanceId: string, patch: RuntimeConfigPatch) => void;
  getInstance: (instanceId: string | null | undefined) => AgentConversationInstance | null;
  updateThread: (instanceId: string, patch: { threadId?: string | null; agentType?: AgentTypeKey }) => void;
  renameInstance: (instanceId: string, title: string) => void;
  removeInstance: (instanceId: string) => void;
  removeInstancesForThread: (threadId: string) => void;
  resolveSessionByThreadId: (localThreadId: string, sessionId: string, agentType: AgentTypeKey) => string | null;
  findByThreadId: (threadId: string) => AgentConversationInstance | null;
  getMessageState: (threadId: string | null | undefined) => AgentConversationMessageState | null;
  mergeMessages: (agentType: AgentTypeKey, threadId: string, messages: ChatMessage[]) => void;
  syncRenderableMessages: (agentType: AgentTypeKey, threadId: string, messages: ChatMessage[]) => void;
  syncLiveMessageState: (agentType: AgentTypeKey, threadId: string, liveState: LiveMessageState) => void;
  resetMessageStates: (threadIds: string[]) => void;
  loadMessages: (agentType: AgentTypeKey, threadId: string) => Promise<void>;
  loadMoreMessages: (agentType: AgentTypeKey, threadId: string) => Promise<void>;
}

// --------------------------------------------------------------------
// Persist config
// --------------------------------------------------------------------
// Instance helpers (Phase 5.3: 直接在 session-store 上实现 instance
// 管理, 不经 convStore late binding, 消除 mirror 反馈环)
// --------------------------------------------------------------------

let _instanceSeq = 0;

function _normalizeTitle(title: string | null | undefined): string {
  return stripSystemBlock(title ?? "").replace(/\s+/g, " ").trim();
}

function _persistInstance(instance: AgentConversationInstance): Promise<void> {
  return agentClient
    .upsertConversationInstance({
      ...instance,
      runtimeConfig:
        instance.runtimeConfig && Object.keys(instance.runtimeConfig).length > 0
          ? JSON.stringify(instance.runtimeConfig)
          : null,
    })
    .then(() => undefined)
    .catch((err) => {
      console.error("[AgentSession] Failed to persist instance:", err);
    });
}

function _deletePersistedInstance(instanceId: string): void {
  agentClient.deleteConversationInstance(instanceId).catch((err) => {
    console.error("[AgentSession] Failed to delete instance:", err);
  });
}

function _deletePersistedInstancesForThread(threadId: string): void {
  agentClient.deleteConversationInstancesForThread(threadId).catch((err) => {
    console.error("[AgentSession] Failed to delete thread instances:", err);
  });
}

function _parseRuntimeConfig(value: unknown): RuntimeConfig | null {
  if (!value) return null;
  if (typeof value !== "string") return value as RuntimeConfig;
  try {
    return JSON.parse(value) as RuntimeConfig;
  } catch {
    return null;
  }
}

function _normalizeBackendInstance(
  instance: AgentConversationInstance | BackendAgentConversationInstance,
): AgentConversationInstance {
  return {
    ...instance,
    runtimeConfig: _parseRuntimeConfig(instance.runtimeConfig),
    role: instance.role ?? undefined,
  };
}

// --------------------------------------------------------------------
// Late binding: conv-store / chat-store 在自身初始化后注册 getState,
// 避免循环依赖. session-store 的委托 actions 通过此引用同步调用.
// --------------------------------------------------------------------

type ConvStoreGetState = () => import("@features/agent/store/agent-conversation-store").AgentConversationStore;
type ChatStoreGetState = () => import("@features/agent/store/chat-store").ChatStore;
let _convGetState: ConvStoreGetState | null = null;
let _chatGetState: ChatStoreGetState | null = null;

export function _bindConvStore(getState: ConvStoreGetState): void {
  _convGetState = getState;
}

export function _bindChatStore(getState: ChatStoreGetState): void {
  _chatGetState = getState;
}

function convStore() {
  if (_convGetState) return _convGetState();
  throw new Error("AgentConversationStore not bound. Import agent-conversation-store.ts first.");
}

function chatStore() {
  if (_chatGetState) return _chatGetState();
  throw new Error("ChatStore not bound. Import chat-store.ts first.");
}

// --------------------------------------------------------------------
// Persist (Phase 5 阶段0): session-store 接管 sessionMeta 持久化
// --------------------------------------------------------------------

/**
 * 迁移旧 chat-store persist 格式 (STORAGE_KEYS.CHAT, 扁平 8 字段) → sessionMeta
 * (嵌套 settings). 首次升级到 session-store persist 时, 若 AGENT_SESSION key 无
 * 数据, 从旧 key 读一次迁移; 之后 session-store 自持久化, 旧 key 留待 Phase 5
 * 删 chat-store 时清理. threadLists / lastRunningRunsReconciledAt 不持久化
 * (runtime-fetched / runtime-only), 用 DEFAULT.
 */
function migrateChatPersistToSessionMeta(): AgentSessionMeta | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.CHAT);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: Record<string, unknown> };
    const old = parsed.state;
    if (!old || typeof old !== "object") return null;
    const d = DEFAULT_AGENT_SESSION_META;
    return {
      ...d,
      activeThreadIds:
        (old.activeThreadIds as AgentSessionMeta["activeThreadIds"] | undefined) ??
        d.activeThreadIds,
      activeAgentTypeKey:
        (old.activeAgentTypeKey as AgentSessionMeta["activeAgentTypeKey"] | undefined) ??
        d.activeAgentTypeKey,
      threadTypes:
        (old.threadTypes as AgentSessionMeta["threadTypes"] | undefined) ??
        d.threadTypes,
      currentThreadTitles:
        (old.currentThreadTitles as AgentSessionMeta["currentThreadTitles"] | undefined) ??
        d.currentThreadTitles,
      externalSessionResolutions:
        (old.externalSessionResolutions as AgentSessionMeta["externalSessionResolutions"] | undefined) ??
        d.externalSessionResolutions,
      threadLists: d.threadLists,
      lastRunningRunsReconciledAt: d.lastRunningRunsReconciledAt,
      settings: {
        ...d.settings,
        agentPermissionMode:
          (old.agentPermissionMode as AgentSessionMeta["settings"]["agentPermissionMode"] | undefined) ??
          d.settings.agentPermissionMode,
        agentCodexModel:
          (old.agentCodexModel as AgentSessionMeta["settings"]["agentCodexModel"] | undefined) ??
          d.settings.agentCodexModel,
        agentCodexReasoningEffort:
          (old.agentCodexReasoningEffort as AgentSessionMeta["settings"]["agentCodexReasoningEffort"] | undefined) ??
          d.settings.agentCodexReasoningEffort,
      },
    };
  } catch {
    return null;
  }
}

/**
 * zustand persist merge: 优先用 AGENT_SESSION 自有格式 (嵌套 sessionMeta), 否则
 * 从旧 chat-store 格式迁移. 再 normalize (activeAgentTypeKey selectability
 * fallback + agentPermissionMode 规范化) 防止旧脏数据把 runtime 路由弄崩.
 * threadLists / lastRunningRunsReconciledAt 强制 DEFAULT (不持久化).
 */
function rehydrateSessionMeta(persisted: unknown): AgentSessionMeta {
  const own = (
    persisted as { sessionMeta?: AgentSessionMeta } | null | undefined
  )?.sessionMeta;
  const d = DEFAULT_AGENT_SESSION_META;
  const base: AgentSessionMeta =
    own && typeof own === "object"
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
  return base;
}

// --------------------------------------------------------------------
// Store
// --------------------------------------------------------------------

export const useAgentSessionStore = create<AgentSessionStore>()(
  subscribeWithSelector(
    persist(
    (set, get) => ({
        sessionMeta: DEFAULT_AGENT_SESSION_META,
        conversationRegistry: EMPTY_REGISTRY,
        threadProjections: {},

        // === 核心写入 ===
        dispatch: (event) => {
          set((state) => {
            const current = state.threadProjections[event.threadId] ?? emptyProjection();
            const next = reduceProjection(current, event);
            if (next === current) return state;
            return {
              threadProjections: { ...state.threadProjections, [event.threadId]: next },
            };
          });
        },
        setSessionMeta: (updater) => set((s) => ({ sessionMeta: updater(s.sessionMeta) })),
        setConversationRegistry: (updater) =>
          set((s) => ({ conversationRegistry: updater(s.conversationRegistry) })),
        setThreadProjection: (threadId, updater) => {
          set((state) => {
            const current = state.threadProjections[threadId] ?? emptyProjection();
            const next = updater(current);
            if (next === current) return state;
            return { threadProjections: { ...state.threadProjections, [threadId]: next } };
          });
        },
        removeThreadProjection: (threadId) => {
          set((state) => {
            if (!(threadId in state.threadProjections)) return state;
            const { [threadId]: _, ...rest } = state.threadProjections;
            return { threadProjections: rest };
          });
        },
        resetThreadProjections: (threadIds) => {
          set((state) => {
            const next = { ...state.threadProjections };
            for (const tid of threadIds) next[tid] = emptyProjection();
            return { threadProjections: next };
          });
        },

        // === 简单 setter ===
        setThreadList: (list) =>
          set((s) => ({
            sessionMeta: {
              ...s.sessionMeta,
              threadLists: { ...s.sessionMeta.threadLists, flowix: list },
            },
          })),
        setActiveThreadId: (threadId) =>
          set((s) => ({
            sessionMeta: {
              ...s.sessionMeta,
              activeThreadIds: { ...s.sessionMeta.activeThreadIds, flowix: threadId },
              ...(threadId
                ? { threadTypes: { ...s.sessionMeta.threadTypes, [threadId]: "flowix" as AgentTypeKey } }
                : {}),
            },
          })),
        setActiveCodexThreadId: (threadId) =>
          set((s) => ({
            sessionMeta: {
              ...s.sessionMeta,
              activeThreadIds: { ...s.sessionMeta.activeThreadIds, codex: threadId },
              ...(threadId
                ? { threadTypes: { ...s.sessionMeta.threadTypes, [threadId]: "codex" as AgentTypeKey } }
                : {}),
            },
          })),
        setActiveClaudeThreadId: (threadId) =>
          set((s) => ({
            sessionMeta: {
              ...s.sessionMeta,
              activeThreadIds: { ...s.sessionMeta.activeThreadIds, claude: threadId },
              ...(threadId
                ? { threadTypes: { ...s.sessionMeta.threadTypes, [threadId]: "claude" as AgentTypeKey } }
                : {}),
            },
          })),
        setActiveAgentTypeKey: (typeKey) =>
          set((s) => ({ sessionMeta: { ...s.sessionMeta, activeAgentTypeKey: typeKey } })),
        setActiveAgentThread: (typeKey, threadId) =>
          set((s) => ({
            sessionMeta: {
              ...s.sessionMeta,
              activeAgentTypeKey: typeKey,
              activeThreadIds: { ...s.sessionMeta.activeThreadIds, [typeKey]: threadId },
              ...(threadId
                ? { threadTypes: { ...s.sessionMeta.threadTypes, [threadId]: typeKey } }
                : {}),
            },
          })),
        bindThreadType: (threadId, typeKey) =>
          set((s) => ({
            sessionMeta: {
              ...s.sessionMeta,
              threadTypes: { ...s.sessionMeta.threadTypes, [threadId]: typeKey },
            },
          })),
        setAgentPermissionMode: (mode) =>
          set((s) => ({
            sessionMeta: {
              ...s.sessionMeta,
              settings: { ...s.sessionMeta.settings, agentPermissionMode: mode },
            },
          })),
        setAgentCodexModel: (model) =>
          set((s) => ({
            sessionMeta: {
              ...s.sessionMeta,
              settings: { ...s.sessionMeta.settings, agentCodexModel: model },
            },
          })),
        setAgentCodexReasoningEffort: (effort) =>
          set((s) => ({
            sessionMeta: {
              ...s.sessionMeta,
              settings: { ...s.sessionMeta.settings, agentCodexReasoningEffort: effort },
            },
          })),

        // === 复杂 action 委托 (同步 via late binding) ===
        migrateThreadState: (fromThreadId, toThreadId, typeKey) =>
          void chatStore().migrateThreadState(fromThreadId, toThreadId, typeKey),
        loadThreadList: () => chatStore().loadThreadList(),
        loadThread: (tid) => chatStore().loadThread(tid),
        loadCodexThreadList: () => chatStore().loadCodexThreadList(),
        loadCodexThread: (tid) => chatStore().loadCodexThread(tid),
        loadClaudeThreadList: () => chatStore().loadClaudeThreadList(),
        loadClaudeThread: (tid) => chatStore().loadClaudeThread(tid),
        loadHermesThreadList: () => chatStore().loadHermesThreadList(),
        loadHermesThread: (tid) => chatStore().loadHermesThread(tid),
        loadAgentThread: (typeKey, tid) => chatStore().loadAgentThread(typeKey, tid),
        loadLocalAgentThreadList: (typeKey) => chatStore().loadLocalAgentThreadList(typeKey),
        loadThreadCache: (tid) => chatStore().loadThreadCache(tid),
        loadMoreHistory: (typeKey, tid) => chatStore().loadMoreHistory(typeKey, tid),
        deleteThread: (tid) => chatStore().deleteThread(tid),
        renameThread: (tid, title, typeKey) => chatStore().renameThread(tid, title, typeKey),
        renameAgentConversation: (input) => chatStore().renameAgentConversation(input),
        sendMessageToThread: (tid, content, typeKey, options) =>
          chatStore().sendMessageToThread(tid, content, typeKey, options),
        stopStream: () => chatStore().stopStream(),
        stopThreadRun: (tid, runId) => chatStore().stopThreadRun(tid, runId),
        dispatchAgentEvent: (event) => void chatStore().dispatchAgentEvent(event),
        flushAgentEventBuffer: () => void chatStore().flushAgentEventBuffer(),
        dispatchAgentChunk: (chunk) => void chatStore().dispatchAgentChunk(chunk),
        reconcileRunningRunsFromSnapshot: (running) =>
          void chatStore().reconcileRunningRunsFromSnapshot(running),
        reconcileRunningRuns: () => chatStore().reconcileRunningRuns(),

        // === Instance actions ===
        // Phase 5.3: createInstance / upsertInstance / updateThread /
        // setRuntimeConfig 直接写 conversationRegistry + 调 agentClient
        // 持久化, 不经 convStore late binding. 消除 setWithInstanceMirror
        // -> setConversationRegistry -> mirror -> conv-store 双写反馈环
        // (该反馈环导致 agent-thread-card-view.tsx 17 分钟超时).
        hydrateFromBackend: async () => {
          try {
            const instances = await agentClient.listConversationInstances();
            set((state) => {
              const next = { ...state.conversationRegistry.instances };
              for (const instance of instances) {
                const normalized = _normalizeBackendInstance(instance);
                const existing = next[normalized.instanceId];
                if (!existing || normalized.updatedAt >= existing.updatedAt) {
                  next[normalized.instanceId] = normalized;
                }
              }
              return { conversationRegistry: { instances: next } };
            });
          } catch (err) {
            console.error("[AgentSession] Failed to hydrate instances:", err);
          }
        },
        createInstance: (input) => {
          const now = Date.now();
          _instanceSeq += 1;
          const instance: AgentConversationInstance = {
            instanceId: `agent-inst-${now}-${_instanceSeq}`,
            agentType: input.agentType,
            title: _normalizeTitle(input.title),
            threadId: input.threadId ?? null,
            runtimeConfig: input.runtimeConfig ?? null,
            source: input.source,
            role: input.role,
            createdAt: now,
            updatedAt: now,
          };
          get().setConversationRegistry((reg) => ({
            ...reg,
            instances: { ...reg.instances, [instance.instanceId]: instance },
          }));
          void _persistInstance(instance);
          return instance;
        },
        upsertInstance: (instanceId, patch) => {
          const existing = get().conversationRegistry.instances[instanceId];
          const now = Date.now();
          const nextInstance: AgentConversationInstance = {
            instanceId,
            agentType: patch.agentType ?? existing?.agentType ?? "flowix",
            title:
              patch.title !== undefined
                ? _normalizeTitle(patch.title)
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
          get().setConversationRegistry((reg) => ({
            ...reg,
            instances: { ...reg.instances, [instanceId]: nextInstance },
          }));
          void _persistInstance(nextInstance);
          return nextInstance;
        },
        setRuntimeConfig: (instanceId, patch) => {
          const existing = get().conversationRegistry.instances[instanceId];
          if (!existing) return;
          const mergedConfig: RuntimeConfig = { ...(existing.runtimeConfig ?? {}) };
          for (const key of Object.keys(patch) as (keyof RuntimeConfigPatch)[]) {
            const value = patch[key];
            if (value === undefined) continue;
            (mergedConfig as Record<string, unknown>)[key] = value;
          }
          const nextInstance = { ...existing, runtimeConfig: mergedConfig, updatedAt: Date.now() };
          get().setConversationRegistry((reg) => ({
            ...reg,
            instances: { ...reg.instances, [instanceId]: nextInstance },
          }));
          void _persistInstance(nextInstance);
        },
        getInstance: (instanceId) => {
          const reg = get().conversationRegistry.instances;
          return instanceId ? (reg[instanceId] ?? null) : null;
        },
        updateThread: (instanceId, patch) => {
          const existing = get().conversationRegistry.instances[instanceId];
          if (!existing) return;
          const nextInstance: AgentConversationInstance = {
            ...existing,
            agentType: patch.agentType ?? existing.agentType,
            threadId:
              patch.threadId !== undefined ? patch.threadId : existing.threadId,
            updatedAt: Date.now(),
          };
          get().setConversationRegistry((reg) => ({
            ...reg,
            instances: { ...reg.instances, [instanceId]: nextInstance },
          }));
          void _persistInstance(nextInstance);
        },
        renameInstance: (instanceId, title) => {
          const nextTitle = _normalizeTitle(title);
          if (!nextTitle) return;
          const existing = get().conversationRegistry.instances[instanceId];
          if (!existing || existing.title === nextTitle) return;
          const nextInstance: AgentConversationInstance = {
            ...existing,
            title: nextTitle,
            updatedAt: Date.now(),
          };
          set((state) => ({
            conversationRegistry: {
              instances: {
                ...state.conversationRegistry.instances,
                [instanceId]: nextInstance,
              },
            },
          }));
          void _persistInstance(nextInstance);
        },
        removeInstance: (instanceId) => {
          set((state) => {
            if (!state.conversationRegistry.instances[instanceId]) return state;
            const { [instanceId]: _removed, ...instances } =
              state.conversationRegistry.instances;
            return { conversationRegistry: { instances } };
          });
          _deletePersistedInstance(instanceId);
        },
        removeInstancesForThread: (threadId) => {
          const removedIds: string[] = [];
          set((state) => {
            const instances = Object.fromEntries(
              Object.entries(state.conversationRegistry.instances).filter(
                ([instanceId, instance]) => {
                  const remove = instance.threadId === threadId;
                  if (remove) removedIds.push(instanceId);
                  return !remove;
                },
              ),
            );
            return { conversationRegistry: { instances } };
          });
          get().removeThreadProjection(threadId);
          for (const instanceId of removedIds) _deletePersistedInstance(instanceId);
          _deletePersistedInstancesForThread(threadId);
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
            const local = state.threadProjections[localThreadId];
            if (!local) return state;
            const existing =
              state.threadProjections[sessionId] ?? emptyProjection();
            const merged = mergeThreadProjections(local, existing, agentType);
            const { [localThreadId]: _removed, ...rest } = state.threadProjections;
            return { threadProjections: { ...rest, [sessionId]: merged } };
          });
          return instance?.instanceId ?? null;
        },
        findByThreadId: (threadId) => {
          const instances = get().conversationRegistry.instances;
          return (
            Object.values(instances).find((inst) => inst.threadId === threadId) ?? null
          );
        },
        getMessageState: (threadId) => {
          if (!threadId) return null;
          const p = get().threadProjections[threadId];
          if (!p) return null;
          return {
            messages: p.messages,
            pendingAssistantId: p.pending.assistantId,
            pendingReasoningId: p.pending.reasoningId,
            oldestSequence: p.pagination.oldestSequence,
            hasMoreHistory: p.pagination.hasMoreHistory,
            loadingInitial: p.pagination.loadingInitial,
            loadingMore: p.pagination.loadingMore,
          };
        },
        mergeMessages: (agentType, threadId, messages) =>
          convStore().mergeMessages(agentType, threadId, messages),
        syncRenderableMessages: (agentType, threadId, messages) =>
          convStore().syncRenderableMessages(agentType, threadId, messages),
        syncLiveMessageState: (agentType, threadId, liveState) =>
          convStore().syncLiveMessageState(agentType, threadId, liveState),
        resetMessageStates: (threadIds) => {
          get().resetThreadProjections(threadIds);
        },
        // Phase 5 (2026-08-03): conv-store.loadMessages / loadMoreMessages
        // 已写真源 session-store.threadProjections (不再读 / 写
        // conv-store.messageStates), 这里保持原 delegate 路径, 让
        // useAgentSessionStore.loadMessages / loadMoreMessages 这个
        // 公共 API 仍然 callable. 没有循环 ── 因为 conv-store.loadMessages
        // 写真源时直接用 useAgentSessionStore.setThreadProjection,
        // 不再调 session-store.loadMessages (避免 loop).
        loadMessages: (agentType, threadId) =>
          convStore().loadMessages(agentType, threadId),
        loadMoreMessages: (agentType, threadId) =>
          convStore().loadMoreMessages(agentType, threadId),
    }),
    {
      name: STORAGE_KEYS.AGENT_SESSION,
      partialize: (state) => ({
        sessionMeta: {
          ...state.sessionMeta,
          // runtime-fetched / runtime-only, 不持久化 (与 chat-store partializeChat 对齐)
          threadLists: DEFAULT_AGENT_SESSION_META.threadLists,
          lastRunningRunsReconciledAt:
            DEFAULT_AGENT_SESSION_META.lastRunningRunsReconciledAt,
        },
      }),
      merge: (persisted, current) => ({
        ...current,
        sessionMeta: rehydrateSessionMeta(persisted),
      }),
    },
    ),
  ),
);

// --------------------------------------------------------------------
// Selectors
// --------------------------------------------------------------------

export const selectThreadProjection = (
  state: AgentSessionStore,
  threadId: string,
): ThreadProjection | undefined => state.threadProjections[threadId];

export const selectSessionMeta = (state: AgentSessionStore) => state.sessionMeta;

export const selectConversationRegistry = (state: AgentSessionStore) =>
  state.conversationRegistry;