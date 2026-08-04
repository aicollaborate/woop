import type { ChatMessage } from "@/types";
import type { AgentTypeKey } from "@/types/agent";
import type { AgentConversationMessageState } from "@features/agent/store/agent-conversation-types";
import type { LiveMessageState } from "@features/agent/store/chunk-result";
import type { ProjectionSlice } from "@features/agent/store/projection-slice";
import { emptyProjection } from "@features/agent/store/session-reducer";
import {
  filterRenderableHistoryMessages,
  getHistoryPage,
  getInitialThreadHistory,
  HISTORY_PAGE_SIZE,
  mergeHistoricalMessages,
  mergeLiveMessagesIntoRenderableMessages,
  prependHistoricalMessages,
  replaceCompletedRunWithHistory,
  trySwapLastLiveMessage,
} from "@features/agent/store/thread-history";

type SessionSet = (
  updater: (state: HistoryContext) => Partial<HistoryContext> | HistoryContext,
) => void;
type HistoryContext = ThreadHistorySlice & ProjectionSlice;
type SessionGet = () => HistoryContext;

export interface ThreadHistorySlice {
  getMessageState(
    threadId: string | null | undefined,
  ): AgentConversationMessageState | null;
  mergeMessages(
    agentType: AgentTypeKey,
    threadId: string,
    messages: ChatMessage[],
  ): void;
  syncRenderableMessages(
    agentType: AgentTypeKey,
    threadId: string,
    messages: ChatMessage[],
  ): void;
  syncLiveMessageState(
    agentType: AgentTypeKey,
    threadId: string,
    liveState: LiveMessageState,
  ): void;
  resetMessageStates(threadIds: string[]): void;
  loadMessages(agentType: AgentTypeKey, threadId: string): Promise<void>;
  reconcileCompletedRun(
    agentType: AgentTypeKey,
    threadId: string,
    runId: string,
  ): Promise<void>;
  loadMoreMessages(agentType: AgentTypeKey, threadId: string): Promise<void>;
}

export function createThreadHistorySlice(
  set: SessionSet,
  get: SessionGet,
): ThreadHistorySlice {
  const isRequestCurrent = (threadId: string, epoch: number) =>
    !get().threadTombstones[threadId] &&
    (get().threadEpochs[threadId] ?? 0) === epoch;

  return {
    getMessageState: (threadId) => {
      if (!threadId) return null;
      const projection = get().threadProjections[threadId];
      if (!projection) return null;
      return {
        messages: projection.messages,
        pendingAssistantId: projection.pending.assistantId,
        pendingReasoningId: projection.pending.reasoningId,
        oldestSequence: projection.pagination.oldestSequence,
        hasMoreHistory: projection.pagination.hasMoreHistory,
        loadingInitial: projection.pagination.loadingInitial,
        loadingMore: projection.pagination.loadingMore,
      };
    },
    mergeMessages: (agentType, threadId, messages) => {
      const renderable = filterRenderableHistoryMessages(messages);
      if (renderable.length === 0) return;
      set((state) => {
        if (state.threadTombstones[threadId]) return state;
        const current = state.threadProjections[threadId] ?? emptyProjection();
        const merged = mergeHistoricalMessages(
          current.messages,
          renderable,
          agentType,
        );
        if (merged === current.messages) return state;
        return {
          threadProjections: {
            ...state.threadProjections,
            [threadId]: { ...current, messages: merged },
          },
        };
      });
    },
    syncRenderableMessages: (agentType, threadId, messages) => {
      const renderable = filterRenderableHistoryMessages(messages);
      if (renderable.length === 0) return;
      set((state) => {
        if (state.threadTombstones[threadId]) return state;
        const current = state.threadProjections[threadId] ?? emptyProjection();
        const merged = mergeLiveMessagesIntoRenderableMessages(
          current.messages,
          renderable,
          agentType,
        );
        if (merged === current.messages) return state;
        return {
          threadProjections: {
            ...state.threadProjections,
            [threadId]: { ...current, messages: merged },
          },
        };
      });
    },
    syncLiveMessageState: (agentType, threadId, liveState) => {
      const renderable = filterRenderableHistoryMessages(liveState.messages);
      set((state) => {
        if (state.threadTombstones[threadId]) return state;
        const current = state.threadProjections[threadId] ?? emptyProjection();
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
          current.pending.assistantId === liveState.pendingAssistantId &&
          current.pending.reasoningId === liveState.pendingReasoningId
        ) {
          return state;
        }
        return {
          threadProjections: {
            ...state.threadProjections,
            [threadId]: {
              ...current,
              messages: merged,
              pending: {
                assistantId: liveState.pendingAssistantId,
                reasoningId: liveState.pendingReasoningId,
              },
            },
          },
        };
      });
    },
    resetMessageStates: (threadIds) => get().resetThreadProjections(threadIds),
    loadMessages: async (agentType, threadId) => {
      if (get().threadProjections[threadId]?.pagination.loadingInitial) return;
      if (get().threadTombstones[threadId]) return;
      const requestEpoch = get().threadEpochs[threadId] ?? 0;
      get().setThreadProjection(threadId, (projection) => ({
        ...projection,
        pagination: { ...projection.pagination, loadingInitial: true },
      }));
      try {
        const page = await getInitialThreadHistory(
          agentType,
          threadId,
          HISTORY_PAGE_SIZE,
        );
        if (!isRequestCurrent(threadId, requestEpoch)) return;
        const messages = filterRenderableHistoryMessages(page.messages);
        get().setThreadProjection(threadId, (projection) => ({
          ...projection,
          messages: mergeHistoricalMessages(
            projection.messages,
            messages,
            agentType,
          ),
          pagination: {
            oldestSequence: page.oldestSequence,
            hasMoreHistory: page.hasMore,
            loadingInitial: false,
            loadingMore: false,
          },
        }));
      } catch (error) {
        console.error("[AgentSession] Failed to load messages:", error);
        if (!isRequestCurrent(threadId, requestEpoch)) return;
        get().setThreadProjection(threadId, (projection) => ({
          ...projection,
          pagination: { ...projection.pagination, loadingInitial: false },
        }));
      }
    },
    reconcileCompletedRun: async (agentType, threadId, runId) => {
      if (get().threadTombstones[threadId]) return;
      const requestEpoch = get().threadEpochs[threadId] ?? 0;
      try {
        const page = await getInitialThreadHistory(
          agentType,
          threadId,
          HISTORY_PAGE_SIZE,
        );
        if (!isRequestCurrent(threadId, requestEpoch)) return;
        const messages = filterRenderableHistoryMessages(page.messages);
        get().setThreadProjection(threadId, (projection) => ({
          ...projection,
          messages: replaceCompletedRunWithHistory(
            projection.messages,
            messages,
            runId,
            agentType,
          ),
          pagination: {
            oldestSequence: page.oldestSequence,
            hasMoreHistory: page.hasMore,
            loadingInitial: false,
            loadingMore: false,
          },
        }));
      } catch (error) {
        console.error("[AgentSession] Failed to reconcile completed run:", error);
      }
    },
    loadMoreMessages: async (agentType, threadId) => {
      const current = get().threadProjections[threadId];
      if (
        !current ||
        current.pagination.loadingMore ||
        !current.pagination.hasMoreHistory ||
        current.pagination.oldestSequence === null ||
        get().threadTombstones[threadId]
      ) {
        return;
      }
      const requestEpoch = get().threadEpochs[threadId] ?? 0;
      get().setThreadProjection(threadId, (projection) => ({
        ...projection,
        pagination: { ...projection.pagination, loadingMore: true },
      }));
      try {
        const page = await getHistoryPage(
          agentType,
          threadId,
          current.pagination.oldestSequence,
          HISTORY_PAGE_SIZE,
        );
        if (!isRequestCurrent(threadId, requestEpoch)) return;
        const messages = filterRenderableHistoryMessages(page.messages);
        get().setThreadProjection(threadId, (projection) => ({
          ...projection,
          messages: prependHistoricalMessages(
            projection.messages,
            messages,
            agentType,
          ),
          pagination: {
            oldestSequence:
              page.oldestSequence ?? projection.pagination.oldestSequence,
            hasMoreHistory: page.hasMore,
            loadingInitial: false,
            loadingMore: false,
          },
        }));
      } catch (error) {
        console.error("[AgentSession] Failed to load more messages:", error);
        if (!isRequestCurrent(threadId, requestEpoch)) return;
        get().setThreadProjection(threadId, (projection) => ({
          ...projection,
          pagination: { ...projection.pagination, loadingMore: false },
        }));
      }
    },
  };
}
