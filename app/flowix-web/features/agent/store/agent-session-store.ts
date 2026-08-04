/**
 * `useAgentSessionStore` ── agent session 的单一真源.
 *
 * 三 sub-projection: sessionMeta (localStorage) / conversationRegistry
 * (backend SQLite) / threadProjections (in-memory, 派生自 events).
 *
 * 本文件只负责 Zustand 组合、持久化边界和 runtime 编排。各状态域由 slice
 * 实现，但只在这里执行一次 create/persist，因此消息所有权仍保持单一。
 *
 * 完整方案: `/Users/rop/Desktop/Notes/开发任务管理/Agent 消息双写重构方案.md`
 */

import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  subscribeWithSelector,
} from "zustand/middleware";
import type {
  AgentChunk,
  AgentEvent,
  AgentTypeKey,
  RunInfo,
  RuntimeConfig,
} from "@/types/agent";
import { agentClient } from "@features/agent/store/agent-client";
import type { AgentConversationInstance } from "@features/agent/store/agent-conversation-types";
import { type ThreadProjection } from "@features/agent/store/session-reducer";
import { STORAGE_KEYS } from "@/lib/constants";
import {
  DEFAULT_AGENT_TYPE_KEY,
  getAgentType,
  isAgentTypeSelectable,
  normalizeAgentTypeKey,
} from "@/lib/agent-types";
import { normalizeCodexPermissionMode } from "@features/agent/runtime/agent-runtime-spec";
import {
  createStreamEventDispatcher,
} from "@features/agent/store/stream-event-dispatcher";
import {
  createRunId,
  mapAgentChunkToEvent,
  type AgentEventMapperState,
} from "@features/agent/events/agent-event-mapper";
import { completedRunUserMessageId } from "@features/agent/events/message-identity";
import { resolveExternalChunkThreadId } from "@features/agent/store/external-session";
import {
  recordAgentChunkMapped,
  recordAgentStopRequested,
} from "@features/agent/diagnostics/agent-run-trace";
import { createAgentChunkBridge } from "@features/agent/store/agent-chunk-bridge";
import { hasThreadInterest } from "@features/agent/store/thread-interest";
import {
  defaultExternalThreadTitle,
  getConversationTitleForThread,
  getLanguage,
  normalizeThreadTitle,
} from "@features/agent/store/thread-titles";
import { createSendErrorMessage, prepareUserMessage } from "@features/agent/store/user-message";
import { dispatchChatStream } from "@features/agent/store/chat-stream";
import { translate } from "@/lib/i18n";
import { applyRunStopped } from "@features/agent/store/run-lifecycle";
import { buildInitialInstanceRuntimeConfig } from "@features/agent/store/initial-runtime-config";
import { createAgentSessionStateStorage } from "@features/agent/store/window-session-storage";
import { installGlobalAgentSettingsSync } from "@features/agent/store/global-agent-settings-sync";
import {
  DEFAULT_AGENT_SESSION_META,
  type AgentSessionMeta,
} from "@features/agent/store/session-state";
import {
  createSessionMetaSlice,
  type SessionMetaSlice,
} from "@features/agent/store/session-meta-slice";
import {
  createProjectionSlice,
  type ProjectionSlice,
} from "@features/agent/store/projection-slice";
import {
  createConversationSlice,
  persistConversationInstance,
  type ConversationSlice,
} from "@features/agent/store/conversation-slice";
import {
  createThreadHistorySlice,
  type ThreadHistorySlice,
} from "@features/agent/store/thread-history-slice";
import {
  createThreadLifecycleSlice,
  type ThreadLifecycleSlice,
} from "@features/agent/store/thread-lifecycle-slice";

export {
  DEFAULT_AGENT_SESSION_META,
  type AgentConversationRegistry,
  type AgentSessionMeta,
} from "@features/agent/store/session-state";
import {
  projectionToRuns,
  runsToProjectionRuns,
} from "@features/agent/store/session-reducer";

const RUNNING_RUN_OPTIMISTIC_GRACE_MS = 3000;
const RUN_MISSING_FROM_SNAPSHOT_REASON = "missing_from_snapshot";

// --------------------------------------------------------------------
// Types
// --------------------------------------------------------------------

export interface AgentSessionStore
  extends SessionMetaSlice,
    ProjectionSlice,
    ConversationSlice,
    ThreadHistorySlice,
    ThreadLifecycleSlice {

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

}

// --------------------------------------------------------------------
// Persist config
// --------------------------------------------------------------------
function eventMapperStateForChunk(
  chunk: AgentChunk,
  state: Pick<AgentSessionStore, "sessionMeta" | "threadProjections">,
): AgentEventMapperState {
  const threadId = resolveExternalChunkThreadId(
    chunk,
    state.sessionMeta.externalSessionResolutions,
  );
  const projection = state.threadProjections[threadId];
  return {
    threadTypes: state.sessionMeta.threadTypes,
    externalSessionResolutions: state.sessionMeta.externalSessionResolutions,
    // The mapper only reads activeRunId. Keep this adapter scoped to the one
    // routed thread so high-frequency chunks do not rebuild the whole map.
    threadStates: projection
      ? { [threadId]: { activeRunId: projection.runs.activeRunId } }
      : {},
  };
}

type SessionGet = () => AgentSessionStore;

function ensureConversationInstanceForSession(
  get: SessionGet,
  threadId: string,
  type: AgentTypeKey,
  title: string,
  options?: { defaultTitle?: string },
): AgentConversationInstance {
  const session = get();
  const existing = session.findByThreadId(threadId);
  if (existing) {
    const shouldUpdateTitle =
      title &&
      (type === "flowix" || !options?.defaultTitle || title !== options.defaultTitle);
    return session.upsertInstance(existing.instanceId, {
      agentType: type,
      ...(shouldUpdateTitle ? { title } : {}),
      threadId,
    });
  }
  return session.createInstance({
    agentType: type,
    title,
    threadId,
    source: { kind: "thread-card" },
    runtimeConfig: buildInitialInstanceRuntimeConfig(type),
  });
}

// --------------------------------------------------------------------
// Persist (Phase 5 阶段0): session-store 接管 sessionMeta 持久化
// --------------------------------------------------------------------

/**
 * 迁移旧 chat-store persist 格式 (STORAGE_KEYS.CHAT, 扁平 8 字段) → sessionMeta
 * (嵌套 settings). 首次升级到 session-store persist 时, 若 AGENT_SESSION key 无
 * 数据, 从旧 key 读一次迁移; 之后 session-store 自持久化并删除旧 key。
 * threadLists / lastRunningRunsReconciledAt 不持久化
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
  try {
    localStorage.removeItem(STORAGE_KEYS.CHAT);
  } catch {
    // SSR / restricted storage: persistence middleware handles the same case.
  }
  return base;
}

// --------------------------------------------------------------------
// Store
// --------------------------------------------------------------------

export const useAgentSessionStore = create<AgentSessionStore>()(
  subscribeWithSelector(
    persist(
    (set, get) => {
      const streamDispatcher = createStreamEventDispatcher({
        getProjection: (threadId) => get().threadProjections[threadId],
        getThreadAgentType: (threadId) =>
          get().sessionMeta.threadTypes[threadId] ??
          get().sessionMeta.activeAgentTypeKey,
        resolveThreadId: (threadId) =>
          get().sessionMeta.externalSessionResolutions[threadId] ?? threadId,
        canDispatch: (threadId) => !get().threadTombstones[threadId],
        dispatch: (event) => get().dispatch(event),
        applySessionResolved: (event) => get().applySessionResolved(event),
      });
      return ({
        ...createSessionMetaSlice(set, get),
        ...createConversationSlice(set, get),
        ...createProjectionSlice(set, (instance) => {
          persistConversationInstance(instance);
        }),
        ...createThreadHistorySlice(set, get),
        ...createThreadLifecycleSlice(set, get),

        sendMessageToThread: async (threadId, content, typeKey, options) => {
          const trimmed = content.trim();
          if (!threadId || (!trimmed && !options?.imagePaths?.length)) return;
          const state = get();
          const type = getAgentType(
            typeKey ??
              state.sessionMeta.threadTypes[threadId] ??
              state.sessionMeta.activeAgentTypeKey,
          );
          state.bindThreadType(threadId, type.key);
          const isFirstMessage =
            options?.isFirstMessage ??
            (state.threadProjections[threadId]?.messages.length ?? 0) === 0;
          const conversationTitle = normalizeThreadTitle(options?.conversationTitle);
          if (isFirstMessage && conversationTitle) {
            state.setSessionMeta((meta) => ({
              ...meta,
              currentThreadTitles: {
                ...meta.currentThreadTitles,
                [type.key]: conversationTitle,
              },
              threadLists: {
                ...meta.threadLists,
                [type.key]: (meta.threadLists[type.key] ?? []).map((item) =>
                  item.threadId === threadId
                    ? { ...item, title: conversationTitle }
                    : item,
                ),
              },
            }));
          }
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
          userMessage.id = completedRunUserMessageId(type.key, runId);
          const startedAt = Date.now();
          state.dispatch({
            kind: "stream_start",
            agentType: type.key,
            threadId,
            runId,
            timestamp: startedAt,
          });
          state.dispatch({
            kind: "user_message",
            agentType: type.key,
            threadId,
            runId,
            timestamp: startedAt,
            text: userMessage.content,
            id: userMessage.id,
          });
          if (options?.instanceId) {
            state.updateThread(options.instanceId, { threadId, agentType: type.key });
          }
          const settings = get().sessionMeta.settings;
          try {
            await dispatchChatStream({
              threadId,
              content: trimmed,
              llmContent,
              runId,
              userPayload,
              agentType: type.key,
              permissionMode: settings.agentPermissionMode,
              codexModel: settings.agentCodexModel,
              codexReasoningEffort: settings.agentCodexReasoningEffort,
              agentRoleMemoId: options?.agentRoleMemoId,
              agentRoleName: options?.agentRoleName,
              runtimeConfig: options?.runtimeConfig ?? undefined,
              imagePaths: options?.imagePaths,
              conversationTitle:
                isFirstMessage && conversationTitle ? conversationTitle : undefined,
            });
          } catch (err) {
            console.error("Failed to dispatch thread card chat_stream:", err);
            const errorMessage = createSendErrorMessage(
              err,
              translate(getLanguage(), "agent.chat.sendFailed"),
            );
            get().dispatch({
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
          const meta = get().sessionMeta;
          const type = getAgentType(meta.activeAgentTypeKey);
          const activeId = meta.activeThreadIds[type.key];
          if (activeId) await get().stopThreadRun(activeId);
        },
        stopThreadRun: async (threadId, runId) => {
          if (!threadId) return;
          streamDispatcher.flushBuffer();
          let targetRunId: string | undefined;
          get().setThreadProjection(threadId, (projection) => {
            const candidate = runId ?? projection.runs.activeRunId ?? undefined;
            if (!candidate || !projection.runs.runs[candidate]) return projection;
            targetRunId = candidate;
            const run = projection.runs.runs[candidate];
            recordAgentStopRequested(threadId, candidate, run.agentType);
            const runs = applyRunStopped(projectionToRuns(projection), candidate, Date.now());
            return {
              ...projection,
              runs: runsToProjectionRuns(runs),
              pending: { assistantId: null, reasoningId: null },
            };
          });
          try {
            const meta = get().sessionMeta;
            const type = getAgentType(
              meta.threadTypes[threadId] ?? meta.activeAgentTypeKey,
            );
            await agentClient.stopChatStream(threadId, type.key, targetRunId);
          } catch (err) {
            console.error("Failed to stop stream:", err);
          }
        },
        dispatchAgentEvent: (event) => streamDispatcher.dispatch(event),
        flushAgentEventBuffer: () => streamDispatcher.flushBuffer(),
        dispatchAgentChunk: (chunk) => {
          const state = get();
          const event = mapAgentChunkToEvent(
            chunk,
            eventMapperStateForChunk(chunk, state),
          );
          recordAgentChunkMapped(chunk, event);
          streamDispatcher.dispatch(event);
        },
        reconcileRunningRunsFromSnapshot: (running) => {
          const now = Date.now();
          const snapshotThreadIds = new Set<string>();
          for (const [reportedThreadId, info] of Object.entries(running)) {
            const localThreadId = info.pendingThreadId || reportedThreadId;
            const canonicalThreadId = info.sessionId || localThreadId;
            snapshotThreadIds.add(canonicalThreadId);
            const current = get();
            const agentType = normalizeAgentTypeKey(
              info.agentType ??
                current.sessionMeta.threadTypes[canonicalThreadId] ??
                current.sessionMeta.threadTypes[localThreadId] ??
                current.sessionMeta.activeAgentTypeKey,
            );
            if (localThreadId !== canonicalThreadId) {
              current.resolveSessionByThreadId(
                localThreadId,
                canonicalThreadId,
                agentType,
              );
            }
            get().setSessionMeta((meta) => ({
              ...meta,
              threadTypes: {
                ...meta.threadTypes,
                [localThreadId]: agentType,
                [canonicalThreadId]: agentType,
              },
              externalSessionResolutions:
                localThreadId !== canonicalThreadId
                  ? {
                      ...meta.externalSessionResolutions,
                      [localThreadId]: canonicalThreadId,
                    }
                  : meta.externalSessionResolutions,
            }));
            const titleMeta = get().sessionMeta;
            ensureConversationInstanceForSession(
              get,
              canonicalThreadId,
              agentType,
              normalizeThreadTitle(
                getConversationTitleForThread(
                  titleMeta,
                  agentType,
                  canonicalThreadId,
                ),
              ),
              { defaultTitle: defaultExternalThreadTitle(agentType) },
            );
            const startedAt = info.startedAt || now;
            get().setThreadProjection(canonicalThreadId, (projection) => {
              const runId =
                info.runId ??
                projection.runs.activeRunId ??
                `${canonicalThreadId}-${now}`;
              const existing = projection.runs.runs[runId];
              return {
                ...projection,
                runs: {
                  isLoading: true,
                  activeRunId: runId,
                  runs: {
                    ...projection.runs.runs,
                    [runId]: {
                      ...existing,
                      runId,
                      agentType,
                      threadId: canonicalThreadId,
                      startedAt: existing?.startedAt ?? startedAt,
                      status: "running",
                      currentTool: info.currentTool ?? existing?.currentTool ?? null,
                      model: existing?.model,
                      modelId: existing?.modelId,
                    },
                  },
                  lastRun: projection.runs.lastRun,
                },
              };
            });
          }
          for (const [threadId, projection] of Object.entries(
            get().threadProjections,
          )) {
            if (snapshotThreadIds.has(threadId) || !projection.runs.isLoading) continue;
            const activeRunId = projection.runs.activeRunId;
            const activeRun = activeRunId
              ? projection.runs.runs[activeRunId]
              : undefined;
            if (
              activeRun?.startedAt &&
              activeRun.startedAt + RUNNING_RUN_OPTIMISTIC_GRACE_MS > now
            ) {
              continue;
            }
            get().dispatch({
              kind: "stream_end",
              agentType: activeRun?.agentType ?? "flowix",
              threadId,
              runId: activeRunId ?? `missing-${threadId}`,
              timestamp: now,
              reason: RUN_MISSING_FROM_SNAPSHOT_REASON,
            });
          }
          get().setSessionMeta((meta) => ({
            ...meta,
            lastRunningRunsReconciledAt: now,
          }));
        },
        reconcileRunningRuns: async () => {
          const running = await agentClient.runningThreads();
          get().reconcileRunningRunsFromSnapshot(running);
          return running;
        },

      });
    },
    {
      name: STORAGE_KEYS.AGENT_SESSION,
      storage: createJSONStorage(() => createAgentSessionStateStorage()),
      partialize: (state) => ({
        sessionMeta: {
          ...state.sessionMeta,
          // runtime-fetched / runtime-only fields are not persisted.
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

installGlobalAgentSettingsSync((updater) =>
  useAgentSessionStore.getState().setSessionMeta(updater),
);

/** Window-local bridge that routes native agent chunks into the canonical store. */
export const acquireAgentChunkBridge = createAgentChunkBridge((chunk) => {
  useAgentSessionStore.getState().dispatchAgentChunk(chunk);
  if (chunk.kind !== "stream_end") return;

  const state = useAgentSessionStore.getState();
  const canonicalThreadId = resolveExternalChunkThreadId(
    chunk,
    state.sessionMeta.externalSessionResolutions,
  );
  const ownsThread =
    hasThreadInterest(canonicalThreadId) ||
    Object.values(state.sessionMeta.activeThreadIds).some(
      (threadId) =>
        threadId === canonicalThreadId ||
        (threadId
          ? state.sessionMeta.externalSessionResolutions[threadId] ===
            canonicalThreadId
          : false),
    );
  if (!ownsThread) return;

  const agentType =
    state.sessionMeta.threadTypes[canonicalThreadId] ??
    state.sessionMeta.threadTypes[chunk.thread_id] ??
    state.sessionMeta.activeAgentTypeKey;
  const runId =
    chunk.run_id ?? state.threadProjections[canonicalThreadId]?.runs.lastRun?.runId;
  if (runId) {
    void state.reconcileCompletedRun(agentType, canonicalThreadId, runId);
  } else {
    void state.loadMessages(agentType, canonicalThreadId);
  }
});
