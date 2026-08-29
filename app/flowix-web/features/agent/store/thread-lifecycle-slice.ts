import type { AgentTypeKey } from "@/types/agent";
import { getAgentType } from "@/lib/agent-types";
import { agentClient } from "@features/agent/store/agent-client";
import type { AgentChunk } from "@/types/agent";
import type { ConversationSlice } from "@features/agent/store/conversation-slice";
import type { ProjectionSlice } from "@features/agent/store/projection-slice";
import type { SessionMetaSlice } from "@features/agent/store/session-meta-slice";
import type { ThreadHistorySlice } from "@features/agent/store/thread-history-slice";
import {
  findHistoryThreadInfo,
  listHistoryThreads,
} from "@features/agent/store/thread-history";
import {
  defaultThreadTitle,
  normalizeThreadTitle,
} from "@features/agent/store/thread-titles";
import { replayExternalEventsForThread } from "@features/agent/store/external-event-replay";
import { useDocumentStore } from "@features/document/store/document-store";
import { useWorkspaceRestoreStore } from "@features/workspace/store/workspace-restore-store";
import { useAgentSessionStore } from "@features/agent/store/agent-session-store";

type SessionSet = (
  updater: (state: LifecycleContext) => Partial<LifecycleContext> | LifecycleContext,
) => void;
type LifecycleContext = ThreadLifecycleSlice &
  ProjectionSlice &
  SessionMetaSlice &
  ConversationSlice &
  ThreadHistorySlice & {
    dispatchAgentChunk(chunk: AgentChunk): void;
    flushAgentEventBuffer(): void;
  };
type SessionGet = () => LifecycleContext;

export interface ThreadLifecycleSlice {
  lifecycleVersion: number;
  migrateThreadState(
    fromThreadId: string,
    toThreadId: string,
    typeKey: AgentTypeKey,
  ): void;
  loadThreadList(): Promise<void>;
  loadThread(threadId: string): Promise<void>;
  loadCodexThreadList(): Promise<void>;
  loadCodexThread(threadId: string): Promise<void>;
  loadClaudeThreadList(): Promise<void>;
  loadClaudeThread(threadId: string): Promise<void>;
  loadHermesThreadList(): Promise<void>;
  loadHermesThread(threadId: string): Promise<void>;
  loadAgentThread(typeKey: AgentTypeKey, threadId: string): Promise<void>;
  loadLocalAgentThreadList(typeKey: AgentTypeKey): Promise<void>;
  loadThreadCache(threadId: string): Promise<void>;
  loadMoreHistory(typeKey: AgentTypeKey, threadId: string): Promise<void>;
  deleteThread(threadId: string, onProviderSuccess?: () => void): Promise<void>;
  archiveThread(threadId: string, onProviderSuccess?: () => void): Promise<void>;
  renameThread(
    threadId: string,
    title: string,
    typeKey?: AgentTypeKey,
  ): Promise<void>;
  renameAgentConversation(input: {
    instanceId?: string | null;
    threadId?: string | null;
    title: string;
    typeKey?: AgentTypeKey;
  }): Promise<void>;
}

async function loadThreadList(
  get: SessionGet,
  typeKey: AgentTypeKey,
  errorLabel: string,
): Promise<void> {
  const type = getAgentType(typeKey);
  try {
    const threads = await listHistoryThreads(type.key);
    get().setSessionMeta((meta) => ({
      ...meta,
      threadLists: { ...meta.threadLists, [type.key]: threads },
    }));
  } catch (error) {
    console.error(`Failed to load ${errorLabel} thread list:`, error);
  }
}

async function loadThread(
  get: SessionGet,
  typeKey: AgentTypeKey,
  threadId: string,
): Promise<void> {
  const type = getAgentType(typeKey);
  try {
    get().invalidateThread(threadId);
    get().activateThread(threadId);
    const requestEpoch = get().threadEpochs[threadId] ?? 0;
    const meta = get().sessionMeta;
    const threadInfo = await findHistoryThreadInfo(
      type.key,
      threadId,
      meta.threadLists[type.key] ?? [],
    );
    get().setSessionMeta((current) => ({
      ...current,
      activeAgentTypeKey: type.key,
      activeThreadIds: { ...current.activeThreadIds, [type.key]: threadId },
      threadTypes: {
        ...current.threadTypes,
        [threadId]: current.threadTypes[threadId] ?? type.key,
      },
      currentThreadTitles: {
        ...current.currentThreadTitles,
        [type.key]: threadInfo?.title ?? defaultThreadTitle(type.key),
      },
    }));
    get().setThreadProjection(threadId, (projection) => ({
      ...projection,
      pending: { assistantId: null, reasoningId: null },
    }));
    if (
      type.key !== "deepseek-harness" &&
      type.key !== "codex" &&
      type.key !== "opencode" &&
      type.key !== "claude"
    ) {
      const replay = await replayExternalEventsForThread(type.key, threadId, {
        canCommit: () =>
          !get().threadTombstones[threadId] &&
          (get().threadEpochs[threadId] ?? 0) === requestEpoch,
        resetThreads: (threadIds, agentType) => {
          get().resetThreadProjections(threadIds);
          get().setSessionMeta((current) => {
            const threadTypes = { ...current.threadTypes };
            for (const id of threadIds) threadTypes[id] ??= agentType;
            return { ...current, threadTypes };
          });
        },
        dispatchChunk: (chunk) => get().dispatchAgentChunk(chunk),
        flush: () => get().flushAgentEventBuffer(),
      });
      if (replay.status === "replayed" || replay.status === "stale") return;
    }
    await get().loadMessages(type.key, threadId);
  } catch (error) {
    console.error(`Failed to load ${type.name} thread:`, error);
  }
}

/** Refresh the provider-backed thread list for one agent type so sidebar
 * state stays aligned after lifecycle actions (archive/delete/rename). */
async function reloadThreadListForType(
  get: SessionGet,
  typeKey: AgentTypeKey,
): Promise<void> {
  const store = get();
  if (typeKey === "deepseek-harness") await store.loadThreadList();
  else if (typeKey === "codex") await store.loadCodexThreadList();
  else if (typeKey === "claude") await store.loadClaudeThreadList();
  else if (typeKey === "hermes") await store.loadHermesThreadList();
  else await store.loadLocalAgentThreadList(typeKey);
}

/** Drop all in-memory references to `threadId` so the titlebar / detail unmount
 * immediately and React rules-of-hooks remain stable across the lifecycle. */
function tearDownLocalThreadState(set: SessionSet, threadId: string): void {
  set((state) => {
    const removedType = state.sessionMeta.threadTypes[threadId];
    const { [threadId]: _removedProjection, ...threadProjections } =
      state.threadProjections;
    const { [threadId]: _removedType, ...threadTypes } =
      state.sessionMeta.threadTypes;
    const externalSessionResolutions = Object.fromEntries(
      Object.entries(state.sessionMeta.externalSessionResolutions).filter(
        ([local, resolved]) => local !== threadId && resolved !== threadId,
      ),
    );
    return {
      threadProjections,
      sessionMeta: {
        ...state.sessionMeta,
        threadTypes,
        externalSessionResolutions,
        ...(removedType
          ? {
              threadLists: {
                ...state.sessionMeta.threadLists,
                [removedType]: (
                  state.sessionMeta.threadLists[removedType] ?? []
                ).filter((item) => item.threadId !== threadId),
              },
            }
          : {}),
        ...(removedType && state.sessionMeta.activeThreadIds[removedType] === threadId
          ? {
              activeThreadIds: {
                ...state.sessionMeta.activeThreadIds,
                [removedType]: undefined,
              },
              currentThreadTitles: {
                ...state.sessionMeta.currentThreadTitles,
                [removedType]: undefined,
              },
            }
          : {}),
      },
    };
  });
}

/** Close the third-column conversation view when its underlying thread is
 * torn down, so the titlebar unmounts before the next render. */
function closeConversationIfActive(threadId: string): void {
  const doc = useDocumentStore.getState();
  const activeInstanceId = doc.activeAgentConversationId;
  if (!activeInstanceId) return;
  const session = useAgentSessionStore.getState();
  const instance = session.getInstance(activeInstanceId);
  if (instance?.threadId !== threadId) return;
  doc.closeAgentConversation();
  useWorkspaceRestoreStore.getState().clearAgentConversation(activeInstanceId);
}

/** Give React/Sonner a real paint opportunity before lifecycle cleanup
 * unmounts the active conversation. One rAF is still before the same paint;
 * two frames guarantee the success toast has become visible to the user. */
function waitForSuccessToastPaint(): Promise<void> {
  if (typeof requestAnimationFrame !== "function") return Promise.resolve();
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

export function createThreadLifecycleSlice(
  set: SessionSet,
  get: SessionGet,
): ThreadLifecycleSlice {
  /** End-to-end archive/delete: dispatches provider-side action by the
   * runtime recorded in sessionMeta, then unconditionally tears down local
   * state (projections, instances, sessionMeta rows, active conversation,
   * workspace restore). IPC errors never leave local residue. */
  const runThreadLifecycle = async (
    threadId: string,
    action: "archive" | "delete",
    onProviderSuccess?: () => void,
  ): Promise<void> => {
    const typeKey = getAgentType(
      get().sessionMeta.threadTypes[threadId] ??
        get().sessionMeta.activeAgentTypeKey,
    );
    get().invalidateThread(threadId);
    // Provider action must succeed before touching local state. Keeping the
    // cleanup out of `finally` prevents the third-column conversation from
    // disappearing while archive/delete is still pending or has failed.
    if (action === "archive") {
      await agentClient.archiveAgentThread(typeKey.key, threadId);
    } else {
      await agentClient.deleteAgentThread(typeKey.key, threadId);
    }

    // Notify the UI as soon as the provider confirms success. Local instance
    // deletion and list refresh can take longer, but must happen after this
    // point and before closing the active conversation.
    onProviderSuccess?.();
    if (onProviderSuccess) await waitForSuccessToastPaint();
    get().invalidateThread(threadId, true);
    await get().removeInstancesForThreadAndWait(threadId);
    tearDownLocalThreadState(set, threadId);
    closeConversationIfActive(threadId);
    // provider 侧列表 (codex thread/list 等) 不再返回该 thread, 刷新让
    // 侧栏与后端状态对齐; 失败不阻塞流程。
    await reloadThreadListForType(get, typeKey.key).catch(() => undefined);
    set((state) => ({ lifecycleVersion: state.lifecycleVersion + 1 }));
  };

  return {
    lifecycleVersion: 0,
    migrateThreadState: (fromThreadId, toThreadId, typeKey) => {
      if (!fromThreadId || !toThreadId || fromThreadId === toThreadId) return;
      get().applySessionResolved({
        kind: "session_resolved",
        agentType: getAgentType(typeKey).key,
        threadId: fromThreadId,
        sessionId: toThreadId,
        runId: `${fromThreadId}-session-resolved`,
        timestamp: Date.now(),
      });
    },
    loadThreadList: () =>
      loadThreadList(get, "deepseek-harness", "DeepSeek Harness"),
    loadThread: (threadId) => loadThread(get, "deepseek-harness", threadId),
    loadCodexThreadList: () => loadThreadList(get, "codex", "Codex"),
    loadCodexThread: (threadId) => loadThread(get, "codex", threadId),
    loadClaudeThreadList: () => loadThreadList(get, "claude", "Claude Code"),
    loadClaudeThread: (threadId) => loadThread(get, "claude", threadId),
    loadHermesThreadList: () => loadThreadList(get, "hermes", "Hermes"),
    loadHermesThread: (threadId) => loadThread(get, "hermes", threadId),
    loadAgentThread: (typeKey, threadId) => loadThread(get, typeKey, threadId),
    loadLocalAgentThreadList: async (typeKey) => {
      const type = getAgentType(typeKey);
      if (["deepseek-harness", "codex", "claude", "hermes"].includes(type.key)) return;
      await loadThreadList(get, type.key, type.name);
    },
    loadThreadCache: async (threadId) => {
      try {
        await get().loadMessages("deepseek-harness", threadId);
      } catch (error) {
        console.error("[AgentSession] Failed to load thread cache:", error);
      }
    },
    loadMoreHistory: async (typeKey, threadId) => {
      await get().loadMoreMessages(getAgentType(typeKey).key, threadId);
    },
    deleteThread: (threadId, onProviderSuccess) =>
      runThreadLifecycle(threadId, "delete", onProviderSuccess),
    archiveThread: (threadId, onProviderSuccess) =>
      runThreadLifecycle(threadId, "archive", onProviderSuccess),
    renameThread: async (threadId, title, typeKey) => {
      const nextTitle = normalizeThreadTitle(title);
      if (!threadId || !nextTitle) return;
      const before = get().sessionMeta;
      const type = getAgentType(
        typeKey ?? before.threadTypes[threadId] ?? before.activeAgentTypeKey,
      );
      const previousListTitle = (before.threadLists[type.key] ?? []).find(
        (item) => item.threadId === threadId,
      )?.title;
      const previousActiveTitle = before.currentThreadTitles[type.key];
      get().setSessionMeta((meta) => ({
        ...meta,
        threadTypes: { ...meta.threadTypes, [threadId]: type.key },
        currentThreadTitles: {
          ...meta.currentThreadTitles,
          [type.key]: nextTitle,
        },
        threadLists: {
          ...meta.threadLists,
          [type.key]: (meta.threadLists[type.key] ?? []).map((item) =>
            item.threadId === threadId ? { ...item, title: nextTitle } : item,
          ),
        },
      }));
      try {
        await agentClient.updateThreadTitle(threadId, nextTitle, type.key);
        await reloadThreadListForType(get, type.key);
      } catch (error) {
        get().setSessionMeta((meta) => ({
          ...meta,
          currentThreadTitles: {
            ...meta.currentThreadTitles,
            [type.key]: previousActiveTitle,
          },
          threadLists: {
            ...meta.threadLists,
            [type.key]: (meta.threadLists[type.key] ?? []).map((item) =>
              item.threadId === threadId && previousListTitle !== undefined
                ? { ...item, title: previousListTitle }
                : item,
            ),
          },
        }));
        console.error("Failed to update thread title:", error);
        throw error;
      }
    },
    renameAgentConversation: async ({ instanceId, threadId, title, typeKey }) => {
      const nextTitle = normalizeThreadTitle(title);
      if (!nextTitle) return;
      const session = get();
      const instance =
        session.getInstance(instanceId) ??
        (threadId ? session.findByThreadId(threadId) : null);
      const targetThreadId = threadId ?? instance?.threadId ?? null;
      const renamed = Object.values(session.conversationRegistry.instances)
        .filter(
          (candidate) =>
            candidate.instanceId === instance?.instanceId ||
            (!!targetThreadId && candidate.threadId === targetThreadId),
        )
        .map((candidate) => ({ id: candidate.instanceId, title: candidate.title }));
      for (const candidate of renamed) {
        session.renameInstance(candidate.id, nextTitle);
      }
      if (!targetThreadId) return;
      try {
        await get().renameThread(
          targetThreadId,
          nextTitle,
          typeKey ?? instance?.agentType,
        );
      } catch (error) {
        for (const candidate of renamed) {
          if (candidate.title) get().renameInstance(candidate.id, candidate.title);
        }
        throw error;
      }
    },
  };
}
