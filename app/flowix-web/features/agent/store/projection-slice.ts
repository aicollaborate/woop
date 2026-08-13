import type { AgentEvent } from "@/types/agent";
import type {
  AgentConversationRegistry,
  AgentSessionMeta,
} from "@features/agent/store/session-state";
import {
  emptyProjection,
  mergeThreadProjections,
  reduceProjection,
  type ThreadProjection,
} from "@features/agent/store/session-reducer";

type SessionSet = (
  updater: (state: ProjectionContext) => Partial<ProjectionContext> | ProjectionContext,
) => void;

type ProjectionContext = ProjectionSlice & {
  sessionMeta: AgentSessionMeta;
  conversationRegistry: AgentConversationRegistry;
};
export interface ProjectionSlice {
  threadProjections: Record<string, ThreadProjection>;
  threadEpochs: Record<string, number>;
  threadTombstones: Record<string, true>;
  dispatch(event: AgentEvent): void;
  setThreadProjection(
    threadId: string,
    updater: (projection: ThreadProjection) => ThreadProjection,
  ): void;
  removeThreadProjection(threadId: string): void;
  resetThreadProjections(threadIds: string[]): void;
  activateThread(threadId: string): void;
  invalidateThread(threadId: string, deleted?: boolean): void;
  applySessionResolved(
    event: AgentEvent & { kind: "session_resolved" },
  ): void;
}

export function createProjectionSlice(
  set: SessionSet,
): ProjectionSlice {
  return {
    threadProjections: {},
    threadEpochs: {},
    threadTombstones: {},
    dispatch: (event) => {
      set((state) => {
        if (state.threadTombstones[event.threadId]) return state;
        const current =
          state.threadProjections[event.threadId] ?? emptyProjection();
        const next = reduceProjection(current, event);
        if (next === current) return state;
        return {
          threadProjections: {
            ...state.threadProjections,
            [event.threadId]: next,
          },
        };
      });
    },
    setThreadProjection: (threadId, updater) => {
      set((state) => {
        if (state.threadTombstones[threadId]) return state;
        const current = state.threadProjections[threadId] ?? emptyProjection();
        const next = updater(current);
        if (next === current) return state;
        return {
          threadProjections: {
            ...state.threadProjections,
            [threadId]: next,
          },
        };
      });
    },
    removeThreadProjection: (threadId) => {
      set((state) => {
        if (!(threadId in state.threadProjections)) return state;
        const { [threadId]: _removed, ...threadProjections } =
          state.threadProjections;
        return { threadProjections };
      });
    },
    resetThreadProjections: (threadIds) => {
      set((state) => {
        const threadProjections = { ...state.threadProjections };
        for (const threadId of threadIds) {
          if (!state.threadTombstones[threadId]) {
            threadProjections[threadId] = emptyProjection();
          }
        }
        return { threadProjections };
      });
    },
    activateThread: (threadId) => {
      if (!threadId) return;
      set((state) => {
        if (!state.threadTombstones[threadId]) return state;
        const { [threadId]: _removed, ...threadTombstones } =
          state.threadTombstones;
        return {
          threadTombstones,
          threadEpochs: {
            ...state.threadEpochs,
            [threadId]: (state.threadEpochs[threadId] ?? 0) + 1,
          },
        };
      });
    },
    invalidateThread: (threadId, deleted = false) => {
      if (!threadId) return;
      set((state) => ({
        threadEpochs: {
          ...state.threadEpochs,
          [threadId]: (state.threadEpochs[threadId] ?? 0) + 1,
        },
        ...(deleted
          ? {
              threadTombstones: {
                ...state.threadTombstones,
                [threadId]: true as const,
              },
            }
          : {}),
      }));
    },
    applySessionResolved: (event) => {
      const localThreadId = event.threadId;
      const sessionId = event.sessionId;
      if (!sessionId || sessionId === localThreadId) return;
      set((state) => {
        const local = state.threadProjections[localThreadId];
        const legacySession = state.threadProjections[sessionId];
        let threadProjections = state.threadProjections;
        if (local || legacySession) {
          const merged = mergeThreadProjections(
            local,
            legacySession,
            event.agentType,
          );
          const { [sessionId]: _removed, ...rest } = threadProjections;
          threadProjections = { ...rest, [localThreadId]: merged };
        }

        return {
          threadProjections,
          threadEpochs: {
            ...state.threadEpochs,
            [sessionId]: (state.threadEpochs[sessionId] ?? 0) + 1,
          },
          threadTombstones: {
            ...state.threadTombstones,
            [sessionId]: true,
          },
          sessionMeta: {
            ...state.sessionMeta,
            threadTypes: {
              ...state.sessionMeta.threadTypes,
              [localThreadId]: event.agentType,
              [sessionId]: event.agentType,
            },
            externalSessionResolutions: {
              ...state.sessionMeta.externalSessionResolutions,
              [localThreadId]: sessionId,
            },
            activeThreadIds: {
              ...state.sessionMeta.activeThreadIds,
              [event.agentType]: localThreadId,
            },
            activeAgentTypeKey: event.agentType,
          },
        };
      });
    },
  };
}
