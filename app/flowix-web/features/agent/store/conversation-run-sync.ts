import type { AgentEvent, AgentTypeKey } from "@/types/agent";
import type { AgentConversationInstance } from "@features/agent/store/agent-conversation-store";
import { useAgentSessionStore } from "@features/agent/store/agent-session-store";
import { buildInitialInstanceRuntimeConfig } from "@features/agent/store/initial-runtime-config";

export function syncConversationInstanceForEvent(event: AgentEvent): void {
  if (event.kind !== "session_resolved" || !event.sessionId) return;
  useAgentSessionStore
    .getState()
    .resolveSessionByThreadId(event.threadId, event.sessionId, event.agentType);
}

/**
 * Ensure a conversation instance exists for `threadId`; return its id.
 *
 * Runtime status is intentionally not mirrored into the instance. Cards read
 * run state from chat thread runtime state or replayed external events.
 *
 * Phase 4 (2026-08-02): findByThreadId 改读 session-store.conversationRegistry
 * 真源. upsertInstance / createInstance 仍走 conv-store action (syncs via
 * setWithInstanceMirror), 但返回值同步写 session-store 真源保证一致性.
 */
export function ensureConversationInstanceForThread(
  threadId: string,
  type: AgentTypeKey,
  title: string,
  options?: {
    defaultTitle?: string;
  },
): AgentConversationInstance {
  // Phase 5 阶段1: 真源切到 session-store, instance 写入不经 conv-store / reverse mirror.
  const session = useAgentSessionStore.getState();
  const existing = session.findByThreadId(threadId);
  if (existing) {
    const shouldUpdateTitle =
      title &&
      (!isExternalAgentType(type) ||
        !options?.defaultTitle ||
        title !== options.defaultTitle);
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

function isExternalAgentType(type: AgentTypeKey): boolean {
  return type !== "flowix";
}
