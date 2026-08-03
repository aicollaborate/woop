import { create } from "zustand";
import { persist, subscribeWithSelector } from "zustand/middleware";
import type { ThreadListItem } from "@/types";
import type {
  AgentChunk,
  AgentCodexModel,
  AgentCodexReasoningEffort,
  AgentEvent,
  AgentPermissionMode,
  AgentTypeKey,
  RunInfo,
  RuntimeConfig,
} from "@/types/agent";
import { STORAGE_KEYS } from "@/lib/constants";
import { translate } from "@/lib/i18n";
import { applyExternalSessionResolved } from "@features/agent/store/external-session";
import { agentClient } from "@features/agent/store/agent-client";
import { createAgentChunkBridge } from "@features/agent/store/agent-chunk-bridge";
import {
  createSendErrorMessage,
  prepareUserMessage,
} from "@features/agent/store/user-message";
import { dispatchChatStream } from "@features/agent/store/chat-stream";
import { createLoadThreadActions } from "@features/agent/store/load-thread-actions";
import {
  createRunId,
  mapAgentChunkToEvent,
} from "@features/agent/events/agent-event-mapper";
import {
  recordAgentChunkMapped,
  recordAgentStopRequested,
} from "@features/agent/diagnostics/agent-run-trace";
import {
  applyRunStarted,
  applyRunStopped,
} from "@features/agent/store/run-lifecycle";
import {
  useAgentConversationStore,
} from "@features/agent/store/agent-conversation-store";
import {
  emptyThreadState,
  type ThreadsMap,
} from "@features/agent/store/thread-runtime-state";
import {
  mergeThreadProjections,
  projectionToRuns,
  runsToProjectionRuns,
} from "@features/agent/store/session-reducer";
import { useAgentSessionStore } from "@features/agent/store/agent-session-store";
import {
  ensureConversationInstanceForThread,
} from "@features/agent/store/conversation-run-sync";
import {
  createStreamEventDispatcher,
  type StreamEventDispatcher,
} from "@features/agent/store/stream-event-dispatcher";
import { startSessionMirror } from "@features/agent/store/session-mirror";
import {
  reconcileThreadStatesFromRunningSnapshot,
} from "@features/agent/store/snapshot-reconcile";

import {
  defaultExternalThreadTitle,
  getConversationTitleForThread,
  getLanguage,
  normalizeThreadTitle,
} from "@features/agent/store/thread-titles";
import {
  activeThreadUpdate,
  getActiveThreadIdForType,
  getThreadListForType,
  threadListUpdate,
  titleUpdate,
  type AgentTypeMap,
} from "@features/agent/store/chat-thread-accessors";
import {
  createChatPersister,
  type ChatPersistShape,
} from "@features/agent/store/chat-store-migration";

function getRenderableMessageCount(threadId: string): number {
  const canonicalMessages =
    useAgentConversationStore.getState().messageStates[threadId]?.messages;
  if (canonicalMessages) return canonicalMessages.length;
  return useChatStore.getState().threadStates[threadId]?.messages.length ?? 0;
}
import {
  DEFAULT_AGENT_TYPE_KEY,
  getAgentType,
  isAgentTypeSelectable,
  normalizeAgentTypeKey,
} from "@/lib/agent-types";
// 注: normalizeAgentTypeKey / DEFAULT_AGENT_TYPE_KEY / isAgentTypeSelectable
// 在此文件中仍直接使用 (reconcile 路径 / activeAgentTypeKey 默认值 /
//   setActiveAgentTypeKey 守门)。

export { threadRunUpdate } from "@features/agent/store/thread-runtime-state";
export type { ThreadState, ThreadsMap } from "@features/agent/store/thread-runtime-state";
export { emptyThreadState } from "@features/agent/store/thread-runtime-state";

/**
 * chat-store 只持有运行时 ChatStore 形状。localStorage 持久化
 * (partialize / merge 配对) 在 chat-store-migration.ts。
 */

export interface ChatStore {
  threadStates: ThreadsMap;
  lastRunningRunsReconciledAt: number | null;
  activeThreadIds: AgentTypeMap<string | undefined>;
  activeAgentTypeKey: AgentTypeKey;
  threadTypes: Record<string, AgentTypeKey>;
  externalSessionResolutions: Record<string, string>;
  agentPermissionMode: AgentPermissionMode;
  agentCodexModel: AgentCodexModel;
  agentCodexReasoningEffort: AgentCodexReasoningEffort;
  threadLists: AgentTypeMap<ThreadListItem[]>;
  currentThreadTitles: AgentTypeMap<string | undefined>;

  // ── actions ──
  setThreadList: (list: ThreadListItem[]) => void;
  /**
   * 切换 active thread ── 各种组件 (document titlebar / thread card) 读
   * activeThreadId 来决定'当前显示哪个 thread'。 纯前端切换, 不发 IPC,
   * 不动 threadStates ── 跟 `loadThread` 的区别: loadThread 还会拉
   * threadInfo 设置 currentThreadTitle, 这里只切 active, 适合'我已经知道
   * threadId, 只想切过去显示'的场景。
   */
  setActiveThreadId: (threadId: string | undefined) => void;
  setActiveCodexThreadId: (threadId: string | undefined) => void;
  setActiveClaudeThreadId: (threadId: string | undefined) => void;
  setActiveAgentTypeKey: (typeKey: AgentTypeKey) => void;
  setActiveAgentThread: (
    typeKey: AgentTypeKey,
    threadId: string | undefined,
  ) => void;
  migrateThreadState: (
    fromThreadId: string,
    toThreadId: string,
    typeKey: AgentTypeKey,
  ) => void;
  bindThreadType: (threadId: string, typeKey: AgentTypeKey) => void;
  setAgentPermissionMode: (mode: AgentPermissionMode) => void;
  setAgentCodexModel: (model: AgentCodexModel) => void;
  setAgentCodexReasoningEffort: (effort: AgentCodexReasoningEffort) => void;
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
  renameAgentConversation: (input: {
    instanceId?: string | null;
    threadId?: string | null;
    title: string;
    typeKey?: AgentTypeKey;
  }) => Promise<void>;
  renameThread: (
    threadId: string,
    title: string,
    typeKey?: AgentTypeKey,
  ) => Promise<void>;
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
      /**
       * Role memo 的 markdown body ── caller (agent-thread-card 组件)
       * 已经在 await 路径里通过 memosClient.readMemo / read_document 拿到,
       * 这里直接拼到首条 user 消息末尾。 仅当 isFirstMessage=true 且
       * agentRoleMemoId 存在时, 才有意义; 其他情况会被忽略。
       */
      agentRoleBody?: string | null;
    },
  ) => Promise<void>;
  /**
   * 终止当前 active thread 的 in-flight chat_stream ── 后端 cancel
   * flag 翻转后, `chat_stream` 走 flush_cancel 退出, 触发 `StreamEnd`
   * chunk, `dispatchAgentChunk` 收敛 isLoading。 这里只负责发信号,
   * UI 状态由 chunk 事件收敛。
   */
  stopStream: () => Promise<void>;
  stopThreadRun: (threadId: string, runId?: string) => Promise<void>;
  dispatchAgentEvent: (event: AgentEvent) => void;
  flushAgentEventBuffer: () => void;

  /**
   * 全局 `agent-chunk` 派发器 ── 由 `useAgentEvents` 在 app.tsx 顶层
   * 挂的 listener 调一次, 按 `chunk.thread_id` 路由到 `threadStates[tid]`。
   * 这是后台多 chat 并行的核心: 一个 listener, 多个 thread_state,
   * chunk 自带 thread_id 自然分流。
   */
  dispatchAgentChunk: (chunk: AgentChunk) => void;
  /**
   * 后端运行快照 reconcile: 后端 `agent_running_threads` 是运行态真源,
   * 前端 registry 只做实时镜像。快照会补齐漏掉的 stream_start, 也会
   * 清掉前端残留的 running 标记。
   */
  reconcileRunningRunsFromSnapshot: (running: Record<string, RunInfo>) => void;
  reconcileRunningRuns: () => Promise<Record<string, RunInfo>>;
}

export const useChatStore = create<ChatStore>()(
  subscribeWithSelector(
    persist(
    (set, get) => {
      const loadActions = createLoadThreadActions(
        (updater) => set(updater),
        () => get() as ChatStore,
      );

      // 流式事件派发器 ── 单一真源 `useAgentSessionStore.dispatch(event)`.
      // 旧 host 注入 (getChatSlice / applyPatch) 已废弃: dispatcher 不再写
      // chat-store.threadStates.messages, 消除与 conversation-store 的双写.
      // chat-store 在 Phase 3 通过 subscribe 镜像 session store 的 threadProjections
      // ── 当前 chat-store.threadStates[tid] 的 messages / pendingAssistantId /
      // pendingReasoningId 字段在流式期间会过期; 渲染层读 useChatStore 不再能拿到
      // live 数据, 切到 useAgentSessionStore / selectRenderableThreadMessages.
      const streamDispatcher: StreamEventDispatcher = createStreamEventDispatcher();
      // 启动 session-store → 旧 store 镜像, 让 6 个月内老组件继续工作.
      startSessionMirror();

      // Phase 5 (2026-08-03): 收窄 meta mirror 到 5 个真正改
      // threadLists / currentThreadTitles 的 action. session-store 真源
      // 已经在 session-mirror.ts 里订阅 sessionMeta → chat-store 镜像
      // (activeThreadIds / threadTypes / activeAgentTypeKey 等都覆盖),
      // 所以绝大多数 chat-store action 改回原 set() 即可, mirror 自动跟随.
      //
      // 仍需 setWithMetaMirror 的 5 处 (改 threadLists / currentThreadTitles):
      //   - setThreadList (loadThreadList family)
      //   - renameThread (title + threadList)
      //   - renameThread error 回滚
      //   - deleteThread (threadList + active title 清空)
      //   - sendMessageToThread isFirstMessage 路径 (title + threadList)
      //
      // Phase 5 删 chat-store 时此 helper 一起删.
      const setWithMetaMirror = (
        updater: (state: ChatStore) => Partial<ChatStore>,
      ): void => {
        const captured: { patch: Partial<ChatStore> | null } = { patch: null };
        set((state) => {
          const patch = updater(state);
          captured.patch = patch;
          return patch;
        });
        const capturedPatch = captured.patch;
        const sessionPatch: Record<string, unknown> = {};
        if (capturedPatch && capturedPatch.threadLists !== undefined) {
          sessionPatch.threadLists = capturedPatch.threadLists;
        }
        if (capturedPatch && capturedPatch.currentThreadTitles !== undefined) {
          sessionPatch.currentThreadTitles = capturedPatch.currentThreadTitles;
        }
        if (Object.keys(sessionPatch).length > 0) {
          useAgentSessionStore.getState().setSessionMeta((meta) => ({
            ...meta,
            ...sessionPatch,
          }));
        }
      };

      return {
        threadStates: {},
        lastRunningRunsReconciledAt: null,
        activeThreadIds: {},
        activeAgentTypeKey: DEFAULT_AGENT_TYPE_KEY,
        threadTypes: {},
        externalSessionResolutions: {},
        agentPermissionMode: "danger-full-access",
        agentCodexModel: "inherit",
        agentCodexReasoningEffort: "medium",
        threadLists: {},
        currentThreadTitles: {},

        setThreadList: (list) => {
          // Phase 4 (2026-08-02): 真源切到 session-store.sessionMeta.threadLists.
          setWithMetaMirror((state) => threadListUpdate(state, "flowix", list));
        },
        setActiveThreadId: (threadId) =>
          set((state) => ({
            ...activeThreadUpdate(state, "flowix", threadId),
            ...(threadId
              ? { threadTypes: { ...state.threadTypes, [threadId]: "flowix" } }
              : {}),
          })),
        setActiveCodexThreadId: (threadId) =>
          set((state) => ({
            ...activeThreadUpdate(state, "codex", threadId),
            ...(threadId
              ? { threadTypes: { ...state.threadTypes, [threadId]: "codex" } }
              : {}),
          })),
        setActiveClaudeThreadId: (threadId) =>
          set((state) => ({
            ...activeThreadUpdate(state, "claude", threadId),
            ...(threadId
              ? { threadTypes: { ...state.threadTypes, [threadId]: "claude" } }
              : {}),
          })),
        setActiveAgentTypeKey: (typeKey) => {
          const type = getAgentType(typeKey);
          if (!isAgentTypeSelectable(type.key)) return;
          // Phase 4 (2026-08-02): 真源切到 session-store.sessionMeta.activeAgentTypeKey.
          useAgentSessionStore.getState().setSessionMeta((meta) => ({
            ...meta,
            activeAgentTypeKey: type.key,
          }));
        },
        setActiveAgentThread: (typeKey, threadId) => {
          const type = getAgentType(typeKey);
          set((state) => ({
            ...activeThreadUpdate(state, type.key, threadId),
            activeAgentTypeKey: type.key,
            ...(threadId
              ? { threadTypes: { ...state.threadTypes, [threadId]: type.key } }
              : {}),
          }));
        },
        migrateThreadState: (fromThreadId, toThreadId, typeKey) => {
          if (!fromThreadId || !toThreadId || fromThreadId === toThreadId)
            return;
          const type = getAgentType(typeKey);
          // Phase 2 (2026-08-02): 同步迁移 session-store.threadProjections
          // ── 这是真源, mirror 会跟随到 chat-store / conv-store. 旧
          // resolveSessionByThreadId 写 conv-store + applyExternalSessionResolved
          // 写 chat-store 已被 mirror 覆盖, 但保留作为迁移期间桥接 (后续
          // snapshot reconcile 仍可能用到). Phase 3 完成后删除.
          // Phase 6 (2026-08-03): 合并逻辑抽到 session-reducer/mergeThreadProjections.
          const session = useAgentSessionStore.getState();
          const fromProj = session.threadProjections[fromThreadId];
          const toProj = session.threadProjections[toThreadId];
          if (fromProj || toProj) {
            const merged = mergeThreadProjections(fromProj, toProj, type.key);
            session.setThreadProjection(toThreadId, () => merged);
            session.removeThreadProjection(fromThreadId);
          }
          // Phase 4 (2026-08-02): 同步写 sessionMeta 真源 ── migration
          // 涉及 threadTypes / externalSessionResolutions / activeThreadIds
          // 三个 metadata 字段, 必须经 sessionStore 真源. 旧 chat-store
          // 这三字段由 mirror 跟随.
          session.setSessionMeta((meta) => ({
            ...meta,
            threadTypes: {
              ...meta.threadTypes,
              [fromThreadId]: type.key,
              [toThreadId]: type.key,
            },
            externalSessionResolutions: {
              ...meta.externalSessionResolutions,
              [fromThreadId]: toThreadId,
            },
            activeThreadIds: {
              ...meta.activeThreadIds,
              [type.key]: toThreadId,
            },
            activeAgentTypeKey: type.key,
          }));
          // 兼容保留: 旧 store 仍收到更新以让非-mirror 路径不立即崩.
          useAgentConversationStore
            .getState()
            .resolveSessionByThreadId(fromThreadId, toThreadId, type.key);
          set((state) => {
            const resolved = applyExternalSessionResolved(
              state,
              fromThreadId,
              toThreadId,
              type.key,
            );
            return {
              ...resolved,
              ...activeThreadUpdate(state, type.key, toThreadId),
              activeAgentTypeKey: type.key,
            };
          });
        },
        bindThreadType: (threadId, typeKey) => {
          const type = getAgentType(typeKey);
          set((state) => ({
            threadTypes: {
              ...state.threadTypes,
              [threadId]: type.key,
            },
          }));
        },
        setAgentPermissionMode: (mode) => {
          // Phase 4 (2026-08-02): 真源切到 session-store.sessionMeta.settings.
          useAgentSessionStore.getState().setSessionMeta((meta) => ({
            ...meta,
            settings: { ...meta.settings, agentPermissionMode: mode },
          }));
        },
        setAgentCodexModel: (model) => {
          useAgentSessionStore.getState().setSessionMeta((meta) => ({
            ...meta,
            settings: { ...meta.settings, agentCodexModel: model },
          }));
        },
        setAgentCodexReasoningEffort: (effort) => {
          useAgentSessionStore.getState().setSessionMeta((meta) => ({
            ...meta,
            settings: { ...meta.settings, agentCodexReasoningEffort: effort },
          }));
        },

        loadThreadList: loadActions.loadThreadList,
        loadThread: loadActions.loadThread,

        loadCodexThreadList: loadActions.loadCodexThreadList,
        loadCodexThread: loadActions.loadCodexThread,

        loadClaudeThreadList: loadActions.loadClaudeThreadList,
        loadClaudeThread: loadActions.loadClaudeThread,

        loadHermesThreadList: loadActions.loadHermesThreadList,
        loadHermesThread: loadActions.loadHermesThread,

        loadAgentThread: loadActions.loadAgentThread,

        loadLocalAgentThreadList: loadActions.loadLocalAgentThreadList,

        loadThreadCache: async (threadId) => {
          try {
            await useAgentConversationStore
              .getState()
              .loadMessages("flowix", threadId);
            set((state) => {
              const existing =
                state.threadStates[threadId] ?? emptyThreadState();
              return {
                threadStates: {
                  ...state.threadStates,
                  [threadId]: existing,
                },
              };
            });
          } catch (err) {
            console.error("Failed to load thread cache:", err);
          }
        },

        loadMoreHistory: async (typeKey, threadId) => {
          const type = getAgentType(typeKey);
          await useAgentConversationStore
            .getState()
            .loadMoreMessages(type.key, threadId);
        },





        deleteThread: async (threadId) => {
          try {
            await agentClient.deleteThread(threadId);
            useAgentConversationStore
              .getState()
              .removeInstancesForThread(threadId);
            // Phase 3 (2026-08-02): 同步清 session-store 真源 ── 这是单
            // 一真源, mirror 会自动把 chat-store / conv-store 投影同步.
            // 直接调 useAgentSessionStore.removeThreadProjection 比 set 整个
            // entry 更彻底, 也避免 listener 在 in-flight 流上写入时拿到
            // stale state 抖动.
            useAgentSessionStore.getState().removeThreadProjection(threadId);
            setWithMetaMirror((state) => {
              // 保留 threadStates[threadId] 这个 entry (不删整条, 避免 listener
              // 在 in-flight 流上写入时拿不到 state ─ 视觉抖动), 但清空
              // messages / oldestSequence / hasMoreHistory / loadingMore,
              // 释放大字段 (tool_data 单条 24KB, 几百条消息的累积内存)。
              // runs 也清掉 ─ 这个 thread 已被 SQLite 删了, 历史 run 不再可读。
              // activeRunId / pendingXxxId 清零, 防止 stopStream 后 flush 缓冲
              // 误把文字写到刚删的 thread。
              // 真源 SQLite 已经删了, 重启后也不会再有该 thread 的 entry。
              //
              // `existing` 必然存在 (deleteThread 由 UI 在有 entry 的 thread 上触发,
              // 后端只删存在的 thread), 因此不需要 "无 entry" 兜底分支 ──
              // 那种状态理论可触发但实测不可达, 写成兜底反而模糊语义。
              const existing = state.threadStates[threadId];
              const clearedEntry = {
                ...existing,
                messages: [],
                oldestSequence: null,
                hasMoreHistory: false,
                loadingMore: false,
                runs: {},
                activeRunId: null,
                pendingAssistantId: null,
                pendingReasoningId: null,
                isLoading: false,
                lastRun: undefined,
              };
              const threadStates = {
                ...state.threadStates,
                [threadId]: clearedEntry,
              };
              // `threadTypes[threadId]` 必然存在: thread 进 threadStates 一定要先经过
              // 之一, 这些入口都同时把 threadTypes[threadId] 写进去。 因此下面
              // `deletedType` 直接读 threadTypes, 不再做 prefix-fallback ──
              // 旧版本那条 fallback (chat-store.ts:1423-1429) 还漏写了 codex
              // / claude 两个 prefix, 实际上是个 latent bug + dead code 一体。
              const deletedType = state.threadTypes[threadId];
              const nextThreadList = getThreadListForType(
                state,
                deletedType,
              ).filter((t) => t.threadId !== threadId);
              // 修复 #7: 之前没清 `state.threadTypes[threadId]`, 留下孤儿条目
              // ── 后续 `get().threadTypes[threadId] ?? "flowix"` 仍会拿到
              // 旧 type, 误判 dispatch 路径。 同样清掉 `externalSessionResolutions`
              // 中指向该 thread 的反向映射 (pending → session), 否则 `findByThreadId`
              // 会误命中已删的 thread id。
              const { [threadId]: _removedType, ...nextThreadTypes } =
                state.threadTypes;
              const nextExternalSessionResolutions = Object.fromEntries(
                Object.entries(state.externalSessionResolutions).filter(
                  ([_, resolved]) => resolved !== threadId,
                ),
              );
              return {
                ...threadListUpdate(state, deletedType, nextThreadList),
                threadStates,
                threadTypes: nextThreadTypes,
                externalSessionResolutions: nextExternalSessionResolutions,
                ...(getActiveThreadIdForType(state, deletedType) === threadId
                  ? {
                      ...activeThreadUpdate(state, deletedType, undefined),
                      ...titleUpdate(state, deletedType, undefined),
                    }
                  : {}),
              };
            });
          } catch (err) {
            console.error("Failed to delete thread:", err);
          }
        },

        renameThread: async (threadId, title, typeKey) => {
          const nextTitle = normalizeThreadTitle(title);
          if (!threadId || !nextTitle) return;
          const type = getAgentType(
            typeKey ?? get().threadTypes[threadId] ?? get().activeAgentTypeKey,
          );
          const before = get();
          const previousListTitle = getThreadListForType(before, type.key).find(
            (item) => item.threadId === threadId,
          )?.title;
          const previousActiveTitle = before.currentThreadTitles[type.key];

          setWithMetaMirror((state) => {
            const currentList = getThreadListForType(state, type.key);
            return {
              ...titleUpdate(state, type.key, nextTitle),
              ...threadListUpdate(
                state,
                type.key,
                currentList.map((item) =>
                  item.threadId === threadId
                    ? { ...item, title: nextTitle }
                    : item,
                ),
              ),
              threadTypes: {
                ...state.threadTypes,
                [threadId]: type.key,
              },
            };
          });

          try {
            await agentClient.updateThreadTitle(threadId, nextTitle, type.key);
            if (type.key === "flowix") await get().loadThreadList();
            else if (type.key === "codex") await get().loadCodexThreadList();
            else if (type.key === "claude") await get().loadClaudeThreadList();
            else if (type.key === "hermes") await get().loadHermesThreadList();
            else await get().loadLocalAgentThreadList(type.key);
          } catch (err) {
            console.error("Failed to update thread title:", err);
            setWithMetaMirror((state) => ({
              ...titleUpdate(state, type.key, previousActiveTitle),
              ...threadListUpdate(
                state,
                type.key,
                getThreadListForType(state, type.key).map((item) =>
                  item.threadId === threadId && previousListTitle !== undefined
                    ? { ...item, title: previousListTitle }
                    : item,
                ),
              ),
            }));
            throw err;
          }
        },

        renameAgentConversation: async ({ instanceId, threadId, title, typeKey }) => {
          const nextTitle = normalizeThreadTitle(title);
          if (!nextTitle) return;
          const instanceStore = useAgentConversationStore.getState();
          const instance =
            instanceStore.getInstance(instanceId) ??
            (threadId ? instanceStore.findByThreadId(threadId) : null);

          const targetThreadId = threadId ?? instance?.threadId ?? null;
          const renamedInstances = Object.values(instanceStore.instances)
            .filter(
              (candidate) =>
                candidate.instanceId === instance?.instanceId ||
                (targetThreadId && candidate.threadId === targetThreadId),
            )
            .map((candidate) => ({
              instanceId: candidate.instanceId,
              title: candidate.title,
            }));
          for (const candidate of renamedInstances) {
            instanceStore.renameInstance(candidate.instanceId, nextTitle);
          }
          if (targetThreadId) {
            try {
              await get().renameThread(
                targetThreadId,
                nextTitle,
                typeKey ?? instance?.agentType,
              );
            } catch (err) {
              for (const candidate of renamedInstances) {
                if (candidate.title) {
                  instanceStore.renameInstance(
                    candidate.instanceId,
                    candidate.title,
                  );
                }
              }
              throw err;
            }
          }
        },

        sendMessageToThread: async (threadId, content, typeKey, options) => {
          const trimmed = content.trim();
          if (!threadId || (!trimmed && !options?.imagePaths?.length)) return;
          const type = getAgentType(
            typeKey ?? get().threadTypes[threadId] ?? get().activeAgentTypeKey,
          );
          get().bindThreadType(threadId, type.key);

          const isFirstMessage =
            options?.isFirstMessage ?? getRenderableMessageCount(threadId) === 0;
          const conversationTitle = normalizeThreadTitle(
            options?.conversationTitle,
          );
          if (isFirstMessage && conversationTitle) {
            setWithMetaMirror((state) => ({
              ...titleUpdate(state, type.key, conversationTitle),
              ...threadListUpdate(
                state,
                type.key,
                getThreadListForType(state, type.key).map((item) =>
                  item.threadId === threadId
                    ? { ...item, title: conversationTitle }
                    : item,
                ),
              ),
            }));
          }
          // Agent Role 文档 (首条消息才追加): caller 已经在 await 路径里
          // 拉好 memo body 后通过 options.agentRoleBody 传入。 这里只
          // 负责拼接到 user 消息末尾 ── body 为空 / 没拉到时传 null,
          // appendFirstMessageContext 静默跳过, 不污染 user 消息。
          const { userPayload, llmContent, userMessage } = prepareUserMessage({
            content: trimmed,
            isFirstMessage,
            agentType: type.key,
            currentNoteContent: options?.currentNoteContent,
            agentRoleMemoId: options?.agentRoleMemoId,
            agentRoleName: options?.agentRoleName,
            agentRoleBody: options?.agentRoleBody ?? null,
            systemReminderDirectory:
              options?.runtimeConfig?.workspaceSnapshot?.notebookPath,
          });
          const runId = createRunId(threadId);
          userMessage.id = `user-${runId}`;

          // Phase 3 (2026-08-02): 乐观 user run 直接写 session-store ── 旧
          // 路径 applyOptimisticUserRun + syncThreadLiveMessageState 双写
          // chat-store / conv-store, mirror 会覆盖 chat-store. 这里把
          // stream_start + user message 作为两个 dispatch 原子落 session-store.
          const startedAt = Date.now();
          useAgentSessionStore.getState().dispatch({
            kind: "stream_start",
            agentType: type.key,
            threadId,
            runId,
            timestamp: startedAt,
          });
          useAgentSessionStore.getState().dispatch({
            kind: "user_message",
            agentType: type.key,
            threadId,
            runId,
            timestamp: startedAt,
            text: userMessage.content,
            id: userMessage.id,
          });
          // bindThreadType 仍要保留 ── sessionMeta.threadTypes 写一次.
          set((state) => ({
            threadTypes: { ...state.threadTypes, [threadId]: type.key },
          }));
          if (options?.instanceId) {
            useAgentConversationStore.getState().updateThread(options.instanceId, {
              threadId,
              agentType: type.key,
            });
          }

          try {
            await dispatchChatStream({
              threadId,
              content: trimmed,
              llmContent,
              runId,
              userPayload,
              agentType: type.key,
              permissionMode: get().agentPermissionMode,
              codexModel: get().agentCodexModel,
              codexReasoningEffort: get().agentCodexReasoningEffort,
              agentRoleMemoId: options?.agentRoleMemoId,
              agentRoleName: options?.agentRoleName,
              runtimeConfig: options?.runtimeConfig ?? undefined,
              imagePaths: options?.imagePaths,
              conversationTitle:
                isFirstMessage && conversationTitle
                  ? conversationTitle
                  : undefined,
            });
          } catch (err) {
            console.error("Failed to dispatch thread card chat_stream:", err);
            const errorMessage = createSendErrorMessage(
              err,
              translate(getLanguage(), "agent.chat.sendFailed"),
            );
            // Phase 3 (2026-08-02): 错误路径直接合成一个 error event 落到
            // session-store, 由 reduceProjection.applyErrorToProjection 原子
            // 合并 messages + 清 runs.pending + 设 lastRun.status=failed.
            useAgentSessionStore.getState().dispatch({
              kind: "error",
              agentType: type.key,
              threadId,
              runId,
              timestamp: Date.now(),
              message: errorMessage.content,
            });
          }
        },


        stopStream: async () => {
          const type = getAgentType(get().activeAgentTypeKey);
          const activeId = getActiveThreadIdForType(get(), type.key);
          if (!activeId) return;
          await get().stopThreadRun(activeId);
        },

        stopThreadRun: async (threadId, runId) => {
          if (!threadId) return;
          // Layer 2: 停流前先 flush 流式缓冲 ── 否则缓冲里残留的 token
          // 会在下一帧 rAF 被 apply 到刚停的 thread, 形成"已停但又冒一段
          // 文字出来"的撕裂. 同步 flush 后再发 stopChatStream IPC, 后端
          // emit StreamEnd 收敛 isLoading.
          streamDispatcher.flushBuffer();
          let targetRunId: string | undefined;
          let stoppedAt: number | null = null;
          // Phase 2 (2026-08-02): 停流状态写 `useAgentSessionStore` 的
          // `threadProjections[tid]`, 由 mirror 自动同步 chat-store. 旧路径
          // 直接写 chat-store.threadStates[tid] 会被 mirror 覆盖, 故删除.
          useAgentSessionStore.getState().setThreadProjection(threadId, (p) => {
            const candidateRunId =
              runId ?? p.runs.activeRunId ?? undefined;
            if (!candidateRunId || !p.runs.runs[candidateRunId]) return p;
            targetRunId = candidateRunId;
            stoppedAt = Date.now();
            const agentType =
              p.runs.runs[candidateRunId]?.agentType ?? "flowix";
            const runsNext = applyRunStopped(
              projectionToRuns(p),
              candidateRunId,
              stoppedAt,
            );
            recordAgentStopRequested(
              threadId,
              candidateRunId,
              agentType,
            );
            return {
              ...p,
              runs: runsToProjectionRuns(runsNext),
              pending: { assistantId: null, reasoningId: null },
            };
          });
          // 修复 #9: 之前 `targetRunId` 早 return 后仍发 IPC, 后端走
          // thread-wide stop 兜底 ── 是浪费, 且本地 store 的 applyRunStopped
          // 在 set() 早 return 时没跑, 用户看不到"已停"的视觉反馈。
          // targetRunId 未解析时仍发 thread-wide stop 兜底。Codex/Claude 等
          // 外部 runtime 可能已经从 local id 迁移到真实 session id, 本地
          // activeRunId 缺失不代表后端没有对应 child process。
          try {
            const type = getAgentType(
              get().threadTypes[threadId] ?? get().activeAgentTypeKey,
            );
            await agentClient.stopChatStream(threadId, type.key, targetRunId);
          } catch (err) {
            console.error("Failed to stop stream:", err);
          }
          // 不手动 set isLoading=false ── 等后端 `flush_cancel` 走完后
          // emit `StreamEnd` chunk, dispatchAgentChunk 收敛。 这样跨
          // 后台 / 前台 thread 行为统一, 不会出现"后端还在 flush 但 UI
          // 已经停了"的撕裂。
        },

        dispatchAgentEvent: (event) => {
          streamDispatcher.dispatch(event);
        },

        flushAgentEventBuffer: () => {
          streamDispatcher.flushBuffer();
        },

        dispatchAgentChunk: (chunk) => {
          const event = mapAgentChunkToEvent(chunk, get());
          recordAgentChunkMapped(chunk, event);
          get().dispatchAgentEvent(event);
        },

        reconcileRunningRunsFromSnapshot: (running) => {
          const now = Date.now();
          const state = get();
          const instanceStore = useAgentConversationStore.getState();
          for (const [threadId, info] of Object.entries(running)) {
            const localThreadId = info.pendingThreadId || threadId;
            const canonicalThreadId = info.sessionId || threadId;
            const type = getAgentType(
              info.agentType ??
                state.threadTypes[canonicalThreadId] ??
                state.threadTypes[localThreadId] ??
                state.activeAgentTypeKey,
            );
            if (info.sessionId && localThreadId !== canonicalThreadId) {
              instanceStore.resolveSessionByThreadId(
                localThreadId,
                canonicalThreadId,
                type.key,
              );
            }
            ensureConversationInstanceForThread(
              canonicalThreadId,
              type.key,
              normalizeThreadTitle(
                getConversationTitleForThread(
                  state,
                  type.key,
                  canonicalThreadId,
                ),
              ),
              {
                defaultTitle: defaultExternalThreadTitle(type.key),
              },
            );
          }
          set((state) =>
            reconcileThreadStatesFromRunningSnapshot(
              state,
              running,
              now,
              (st, info, runId) => {
                const startedAt = info.startedAt || now;
                const canonicalThreadId =
                  info.sessionId || info.pendingThreadId || runId;
                const agentType = normalizeAgentTypeKey(
                  info.agentType ?? state.threadTypes[canonicalThreadId],
                ) as AgentTypeKey;
                return applyRunStarted(
                  st,
                  {
                    kind: "stream_start",
                    agentType,
                    threadId: canonicalThreadId,
                    runId,
                    timestamp: startedAt,
                  },
                  {
                    startedAt,
                    currentTool: info.currentTool ?? null,
                  },
                );
              },
            ),
          );
          // Phase 3 (2026-08-02): 同步 snapshot → session-store 真源.
          // reconcileThreadStatesFromRunningSnapshot 仅写 chat-store, 这里
          // 把每个 running thread 的 projection 也更新一次, 包含 currentTool
          // / model 等 stream_start event 不直接承载的字段. 直接走
          // setThreadProjection 而不是 dispatch stream_start, 因为 reducer
          // 的 stream_start 处理不接受 currentTool 入参.
          //
          // 当 snapshot 把 pending local id 迁到 session id 时, 同步把
          // session-store 的 projection 也合并过去, 不然 mirror 覆盖会让
          // 已经迁到 conv-store 的 messages 丢失 (conv-store 是 mirror 派生).
          const session = useAgentSessionStore.getState();
          for (const [threadId, info] of Object.entries(running)) {
            const localThreadId = info.pendingThreadId || threadId;
            const canonicalThreadId = info.sessionId || localThreadId;
            const startedAt = info.startedAt || now;
            const runId = info.runId ?? `${canonicalThreadId}-${now}`;
            const agentType = (info.agentType ?? "flowix") as AgentTypeKey;

            // 处理 local → session 的消息迁移 (与 conv-store.resolveSessionByThreadId
            // 同语义, 但写 session-store 真源).
            if (
              info.sessionId &&
              localThreadId &&
              localThreadId !== canonicalThreadId
            ) {
              const fromProj = session.threadProjections[localThreadId];
              const toProj = session.threadProjections[canonicalThreadId];
              if (fromProj || toProj) {
                // Phase 6 (2026-08-03): 合并逻辑抽到 session-reducer.
                const merged = mergeThreadProjections(
                  fromProj,
                  toProj,
                  agentType,
                );
                session.setThreadProjection(canonicalThreadId, () => merged);
                session.removeThreadProjection(localThreadId);
              }
            } else {
              // 常规 stream_start ── 仅写 runs 字段, 不动 messages.
              session.setThreadProjection(canonicalThreadId, (p) => {
                const existingRun = p.runs.runs[runId];
                const run: typeof existingRun = {
                  ...existingRun,
                  runId,
                  agentType,
                  threadId: canonicalThreadId,
                  startedAt: existingRun?.startedAt ?? startedAt,
                  status: "running",
                  currentTool:
                    info.currentTool ?? existingRun?.currentTool ?? null,
                  model: existingRun?.model,
                  modelId: existingRun?.modelId,
                };
                return {
                  ...p,
                  runs: {
                    isLoading: true,
                    activeRunId: runId,
                    runs: { ...p.runs.runs, [runId]: run },
                    lastRun: p.runs.lastRun,
                  },
                };
              });
            }
          }
          // 同时处理"快照里没有但本地认为还在跑"的 thread ── 标 failed + 清
          // isLoading, 避免本地"loading 卡死". 复用 snapshot-reconcile 的
          // grace window 规则 ── startedAt + 3s 内的乐观本地 run 跳过.
          const localProjectionKeys = Object.keys(
            useAgentSessionStore.getState().threadProjections,
          );
          const snapshotKeys = new Set(
            Object.entries(running).map(
              ([tid, info]) => info.sessionId || info.pendingThreadId || tid,
            ),
          );
          for (const tid of localProjectionKeys) {
            if (snapshotKeys.has(tid)) continue;
            const p = useAgentSessionStore.getState().threadProjections[tid];
            if (!p || !p.runs.isLoading) continue;
            const activeRunId = p.runs.activeRunId;
            if (activeRunId) {
              const startedAt = p.runs.runs[activeRunId]?.startedAt;
              if (startedAt && startedAt + 3000 > now) continue;
            }
            session.dispatch({
              kind: "stream_end",
              agentType: activeRunId
                ? p.runs.runs[activeRunId]?.agentType ?? "flowix"
                : "flowix",
              threadId: tid,
              runId: activeRunId ?? `missing-${tid}`,
              timestamp: now,
              reason: "missing_from_snapshot",
            });
          }
        },

        reconcileRunningRuns: async () => {
          const running = await agentClient.runningThreads();
          get().reconcileRunningRunsFromSnapshot(running);
          return running;
        },
      };
    },
    {
      name: STORAGE_KEYS.CHAT,
      // 持久化配置 ── schema 详见 chat-store-migration.ts。 这里只透传
      // 一对 partialize / merge, 不再关心字段白名单 / legacy 字段折算。
      ...(() => {
        const persister = createChatPersister();
        return {
          partialize: (state: ChatStore) =>
            persister.partialize(state as unknown as ChatPersistShape),
          merge: (persisted: unknown, current: ChatStore): ChatStore =>
            persister.merge(
              persisted,
              current as unknown as ChatPersistShape,
            ) as unknown as ChatStore,
        };
      })(),
    },
    ),
  ),
);

// ============================================================
// Window-level listener registration.
// ============================================================
//
// Each content-capable Webview (main / tab-host) owns an independent module
// realm and Zustand store. AgentWindowEffects acquires this once in each
// realm; reference counting keeps StrictMode/HMR mounts balanced while the
// underlying event bus still owns only one native Tauri listener.
//
// The shared event bus retries transient Tauri listen failures while this
// logical subscription remains active. Dispatch stays here to avoid a reverse
// dependency from client.ts to the store.

/** Acquire this Webview's single agent-chunk projection bridge. */
export const acquireAgentChunkBridge = createAgentChunkBridge((chunk) => {
  useChatStore.getState().dispatchAgentChunk(chunk);
});

// Phase 5 (2026-08-03): 注册 chat-store getState 到 session-store, 让
// session-store 的委托 actions 可以同步调用本 store. 避免循环依赖:
// session-store 不静态 import 本模块, 而是通过 late binding 获取引用.
import { _bindChatStore } from "@features/agent/store/agent-session-store";
_bindChatStore(() => useChatStore.getState());
