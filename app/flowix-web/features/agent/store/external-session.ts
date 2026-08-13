import type { AgentChunk } from '@/types/agent';
import type { AgentTypeKey } from '@/types/agent';
import {
  emptyThreadState,
  type ThreadState,
} from '@features/agent/store/thread-runtime-state';

export type ExternalSessionThreadStates = Record<string, ThreadState>;

export interface ExternalSessionStateInput {
  threadStates: ExternalSessionThreadStates;
  threadTypes: Record<string, AgentTypeKey>;
  externalSessionResolutions: Record<string, string>;
}

export interface ExternalSessionResolvedState {
  threadStates: ExternalSessionThreadStates;
  threadTypes: Record<string, AgentTypeKey>;
  externalSessionResolutions: Record<string, string>;
}

/** Resolve either a product thread id or provider session id to the product id. */
export function resolveProductThreadId(
  threadId: string,
  resolutions: Record<string, string>,
): string {
  if (resolutions[threadId]) return threadId;
  return Object.entries(resolutions).find(
    ([, externalSessionId]) => externalSessionId === threadId,
  )?.[0] ?? threadId;
}

export function resolveExternalChunkThreadId(
  chunk: AgentChunk,
  resolutions: Record<string, string>
): string {
  return resolveProductThreadId(chunk.thread_id, resolutions);
}

export function resolveExternalChunkAgentType(
  chunk: AgentChunk,
  sourceThreadId: string,
  targetThreadId: string,
  threadTypes: Record<string, AgentTypeKey>
): AgentTypeKey | undefined {
  return chunk.agent_type ?? threadTypes[sourceThreadId] ?? threadTypes[targetThreadId];
}

/**
 * Register the provider session without changing the product-owned thread id.
 * Legacy state may already contain a projection under the provider id; fold it
 * back into the product thread so every UI surface keeps one stable identity.
 */
export function applyExternalSessionResolved(
  state: ExternalSessionStateInput,
  localThreadId: string,
  sessionId: string,
  agentType: AgentTypeKey,
): ExternalSessionResolvedState {
  const productState = state.threadStates[localThreadId] ?? emptyThreadState();
  const legacySessionState = state.threadStates[sessionId] ?? emptyThreadState();
  const { [sessionId]: _legacySessionState, ...threadStates } = state.threadStates;

  return {
    threadTypes: {
      ...state.threadTypes,
      [localThreadId]: agentType,
      [sessionId]: agentType,
    },
    externalSessionResolutions: {
      ...state.externalSessionResolutions,
      [localThreadId]: sessionId,
    },
    threadStates: {
      ...threadStates,
      [localThreadId]: {
        ...productState,
        isLoading: productState.isLoading || legacySessionState.isLoading,
        activeRunId: productState.activeRunId ?? legacySessionState.activeRunId,
        runs: { ...legacySessionState.runs, ...productState.runs },
        oldestSequence:
          productState.oldestSequence ?? legacySessionState.oldestSequence,
        hasMoreHistory:
          productState.hasMoreHistory || legacySessionState.hasMoreHistory,
        loadingMore: productState.loadingMore || legacySessionState.loadingMore,
      },
    },
  };
}
