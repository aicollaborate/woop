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
import {
  liveTurnMessages,
  type CodexLiveTurnCache,
} from "@features/agent/store/codex-live-turn-cache";
import {
  EMPTY_CONVERSATION_RUN_SIGNATURE,
  getConversationRunSignature,
} from "@features/agent/store/conversation-run-signature";

type SessionSet = (
  updater: (state: ProjectionContext) => Partial<ProjectionContext> | ProjectionContext,
) => void;

type ProjectionContext = ProjectionSlice & {
  sessionMeta: AgentSessionMeta;
  conversationRegistry: AgentConversationRegistry;
};
export interface ProjectionSlice {
  threadProjections: Record<string, ThreadProjection>;
  /** Incrementally maintained lifecycle projection used by conversation rows. */
  threadRunSignatures: Record<string, string>;
  /** Changes only when lifecycle fields change, not for message chunks. */
  runStateVersion: number;
  threadEpochs: Record<string, number>;
  threadTombstones: Record<string, true>;
  codexLiveTurns: Record<string, CodexLiveTurnCache>;
  clearCodexLiveTurn(threadId: string, runId?: string): void;
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
  const runStatePatch = (
    state: ProjectionContext,
    threadId: string,
    nextProjection: ThreadProjection | undefined,
  ): Partial<ProjectionContext> => {
    const previousSignature = state.threadRunSignatures[threadId]
      ?? getConversationRunSignature(state.threadProjections[threadId]);
    const nextSignature = getConversationRunSignature(nextProjection);
    if (previousSignature === nextSignature) return {};

    const threadRunSignatures = { ...state.threadRunSignatures };
    if (nextSignature === EMPTY_CONVERSATION_RUN_SIGNATURE) {
      delete threadRunSignatures[threadId];
    } else {
      threadRunSignatures[threadId] = nextSignature;
    }
    return {
      threadRunSignatures,
      runStateVersion: state.runStateVersion + 1,
    };
  };

  return {
    threadProjections: {},
    threadRunSignatures: {},
    runStateVersion: 0,
    threadEpochs: {},
    threadTombstones: {},
    codexLiveTurns: {},
    clearCodexLiveTurn: (threadId, runId) => {
      set((state) => {
        const current = state.codexLiveTurns[threadId];
        if (!current || (runId && current.runId !== runId)) return state;
        const { [threadId]: _removed, ...codexLiveTurns } = state.codexLiveTurns;
        return { codexLiveTurns };
      });
    },
    dispatch: (event) => {
      set((state) => {
        if (state.threadTombstones[event.threadId]) return state;
        const current =
          state.threadProjections[event.threadId] ?? emptyProjection();
        const next = reduceProjection(current, event);
        if (next === current) return state;
        const codexLiveTurns = { ...state.codexLiveTurns };
        if (event.agentType === "codex" && event.runId) {
          if (event.kind === "stream_end" || event.kind === "error") {
            const cached = codexLiveTurns[event.threadId];
            if (cached?.runId === event.runId) {
              codexLiveTurns[event.threadId] = { ...cached, status: "completed", updatedAt: Date.now() };
            }
          } else {
            // Tool events do not repeat the turn id; keep the last one seen
            // so the cache can anchor the run slice after the user row has
            // adopted its provider id.
            const previous = codexLiveTurns[event.threadId];
            const turnId = event.codexTurnId ?? previous?.turnId;
            codexLiveTurns[event.threadId] = {
              runId: event.runId,
              turnId: turnId ?? previous?.turnId,
              messages: liveTurnMessages(next.messages, event.runId, turnId),
              status: "running",
              updatedAt: Date.now(),
            };
          }
        }
        return {
          threadProjections: {
            ...state.threadProjections,
            [event.threadId]: next,
          },
          codexLiveTurns,
          ...runStatePatch(state, event.threadId, next),
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
          ...runStatePatch(state, threadId, next),
        };
      });
    },
    removeThreadProjection: (threadId) => {
      set((state) => {
        if (!(threadId in state.threadProjections)) return state;
        const { [threadId]: _removed, ...threadProjections } =
          state.threadProjections;
        const { [threadId]: _removedLive, ...codexLiveTurns } = state.codexLiveTurns;
        return {
          threadProjections,
          codexLiveTurns,
          ...runStatePatch(state, threadId, undefined),
        };
      });
    },
    resetThreadProjections: (threadIds) => {
      set((state) => {
        const threadProjections = { ...state.threadProjections };
        for (const threadId of threadIds) {
          if (!state.threadTombstones[threadId]) {
            const cached = state.codexLiveTurns[threadId];
            threadProjections[threadId] = {
              ...emptyProjection(),
              ...(cached ? { messages: cached.messages } : {}),
            };
          }
        }
        let threadRunSignatures = state.threadRunSignatures;
        let runStateVersion = state.runStateVersion;
        for (const threadId of threadIds) {
          const patch = runStatePatch(
            { ...state, threadRunSignatures, runStateVersion },
            threadId,
            threadProjections[threadId],
          );
          if (patch.threadRunSignatures) threadRunSignatures = patch.threadRunSignatures;
          if (patch.runStateVersion !== undefined) runStateVersion = patch.runStateVersion;
        }
        return { threadProjections, threadRunSignatures, runStateVersion };
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
        ...(deleted
          ? (() => {
              const { [threadId]: _removed, ...codexLiveTurns } = state.codexLiveTurns;
              return { codexLiveTurns };
            })()
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
        let codexLiveTurns = state.codexLiveTurns;
        if (local || legacySession) {
          const merged = mergeThreadProjections(
            local,
            legacySession,
            event.agentType,
          );
          const { [sessionId]: _removed, ...rest } = threadProjections;
          threadProjections = { ...rest, [localThreadId]: merged };
        }
        if (event.agentType === "codex") {
          const localLive = state.codexLiveTurns[localThreadId];
          const sessionLive = state.codexLiveTurns[sessionId];
          if (localLive || sessionLive) {
            codexLiveTurns = { ...state.codexLiveTurns };
            if (!localLive && sessionLive) codexLiveTurns[localThreadId] = sessionLive;
            delete codexLiveTurns[sessionId];
          }
        }

        const mergedRunPatch = runStatePatch(state, localThreadId, threadProjections[localThreadId]);
        const currentThreadTitles = { ...state.sessionMeta.currentThreadTitles };
        if (sessionId !== localThreadId) {
          const resolvedTitle =
            currentThreadTitles[localThreadId] ?? currentThreadTitles[sessionId];
          if (resolvedTitle !== undefined) {
            currentThreadTitles[localThreadId] = resolvedTitle;
          }
          delete currentThreadTitles[sessionId];
        }
        const removedRunSignature = state.threadRunSignatures[sessionId]
          ?? getConversationRunSignature(state.threadProjections[sessionId]);
        const threadRunSignatures = mergedRunPatch.threadRunSignatures
          ? { ...mergedRunPatch.threadRunSignatures }
          : { ...state.threadRunSignatures };
        delete threadRunSignatures[sessionId];
        const removedRunChanged = removedRunSignature !== EMPTY_CONVERSATION_RUN_SIGNATURE;
        return {
          threadProjections,
          codexLiveTurns,
          threadRunSignatures,
          runStateVersion:
            (mergedRunPatch.runStateVersion ?? state.runStateVersion)
            + (removedRunChanged ? 1 : 0),
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
            currentThreadTitles,
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
