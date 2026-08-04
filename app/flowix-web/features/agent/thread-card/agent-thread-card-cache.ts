import type { AgentTypeKey } from '@/types/agent';
import type { ChatMessage } from '@/types';
import { getAgentType } from '@/lib/agent-types';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
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
    // Phase 5 (2026-08-03): 跳过 replay. replay 路径仅在 loadThreadForType
    // (history list reload) 中调用, 从 events 表重建 state. cache load
    // 路径已 resolve 到 session id, session id 已是后端真源, replay:
    //   1. 对没 events 表记录的 sessions 抛 TypeError (history_replay 失败)
    //   2. 双写 projection, 与 loadMessages 路径冲突
    //   3. 在 mock 测试环境无法 mock agentClient.externalEvents 完整追平
    await useAgentSessionStore.getState().loadMessages(typeKey, threadId);
    // Phase 4 (2026-08-02): 真源切到 session-store.threadProjections.
    return (
      useAgentSessionStore.getState().threadProjections[threadId]?.messages ?? []
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
