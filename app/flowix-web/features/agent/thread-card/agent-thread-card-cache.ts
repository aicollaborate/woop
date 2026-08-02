import type { AgentTypeKey } from '@/types/agent';
import type { ChatMessage } from '@/types';
import { getAgentType } from '@/lib/agent-types';
import { useAgentConversationStore } from '@features/agent/store/agent-conversation-store';
import { useChatStore } from '@features/agent/store/chat-store';
import { replayExternalEventsForThread } from '@features/agent/store/external-event-replay';
import {
  isLocalExternalThreadId,
  resolveExternalSessionId,
} from '@features/agent/services/external-agent-runtime-service';

export interface LoadAgentThreadCardCacheInput {
  threadId: string;
  typeKey: AgentTypeKey;
}

export interface LoadAgentThreadCardCacheResult {
  resolvedSessionId: string | null;
  loadedThreadId: string | null;
  messages: ChatMessage[];
}

const inFlightThreadLoads = new Map<string, Promise<ChatMessage[]>>();

function loadThreadMessages(
  typeKey: AgentTypeKey,
  threadId: string
): Promise<ChatMessage[]> {
  const key = `${typeKey}:${threadId}`;
  const existing = inFlightThreadLoads.get(key);
  if (existing) return existing;

  const load = (async () => {
    const replayedDatabase =
      getAgentType(typeKey).capabilities.externalSessionBacked &&
      (await replayExternalEventsForThread(
        useChatStore.setState,
        useChatStore.getState,
        typeKey,
        threadId
      ));
    if (!replayedDatabase) {
      await useAgentConversationStore.getState().loadMessages(typeKey, threadId);
    }
    return (
      useAgentConversationStore.getState().messageStates[threadId]?.messages ?? []
    );
  })().finally(() => {
    if (inFlightThreadLoads.get(key) === load) {
      inFlightThreadLoads.delete(key);
    }
  });
  inFlightThreadLoads.set(key, load);
  return load;
}

export async function loadAgentThreadCardCache(
  input: LoadAgentThreadCardCacheInput
): Promise<LoadAgentThreadCardCacheResult> {
  const { threadId, typeKey } = input;
  const type = getAgentType(typeKey);

  if (type.capabilities.externalSessionBacked) {
    const isLocalThreadId = isLocalExternalThreadId(threadId, typeKey);
    const sessionId = isLocalThreadId
      ? await resolveExternalSessionId(threadId, typeKey)
      : threadId;

    if (isLocalThreadId && sessionId && sessionId !== threadId) {
      const messages = await loadThreadMessages(typeKey, sessionId);
      return {
        resolvedSessionId: sessionId,
        loadedThreadId: sessionId,
        messages,
      };
    }

    if (sessionId) {
      const messages = await loadThreadMessages(typeKey, sessionId);
      return { resolvedSessionId: null, loadedThreadId: sessionId, messages };
    }

    return { resolvedSessionId: null, loadedThreadId: null, messages: [] };
  }

  const messages = await loadThreadMessages(typeKey, threadId);
  return { resolvedSessionId: null, loadedThreadId: threadId, messages };
}
