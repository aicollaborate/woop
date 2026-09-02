import type { AgentChunk, AgentTypeKey } from "@/types/agent";
import type { AgentEventMapperState } from "@features/agent/events/agent-event-mapper";
import { resolveExternalChunkThreadId } from "@features/agent/store/external-session";

interface ChunkRoutingState {
  sessionMeta: {
    threadTypes: Record<string, AgentTypeKey>;
    externalSessionResolutions: Record<string, string>;
  };
  threadProjections: Record<string, {
    runs: {
      activeRunId: string | null;
      lastRun?: { runId: string } | null;
    };
  }>;
}

/** Build the minimal mapper snapshot for one routed chunk. */
export function eventMapperStateForChunk(
  chunk: AgentChunk,
  state: ChunkRoutingState,
): AgentEventMapperState {
  const threadId = resolveExternalChunkThreadId(
    chunk,
    state.sessionMeta.externalSessionResolutions,
  );
  const projection = state.threadProjections[threadId];
  return {
    threadTypes: state.sessionMeta.threadTypes,
    externalSessionResolutions: state.sessionMeta.externalSessionResolutions,
    threadStates: projection
      ? {
          [threadId]: {
            activeRunId: projection.runs.activeRunId,
            lastRunId: projection.runs.lastRun?.runId,
          },
        }
      : {},
  };
}
