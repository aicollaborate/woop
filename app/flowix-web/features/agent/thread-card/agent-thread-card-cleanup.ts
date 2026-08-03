import type { AgentTypeKey } from "@/types/agent";
import { normalizeAgentTypeKey } from "@/lib/agent-types";
import { useAgentSessionStore } from "@features/agent/store/agent-session-store";

export interface AgentThreadCardCleanupAttrs {
  threadId?: unknown;
  instanceId?: unknown;
  typeKey?: unknown;
}

export function terminateAgentThreadCardRuntime(
  attrs: AgentThreadCardCleanupAttrs,
): void {
  const threadId = typeof attrs.threadId === "string" ? attrs.threadId : null;
  const instanceId =
    typeof attrs.instanceId === "string" ? attrs.instanceId : null;
  const typeKey = normalizeAgentTypeKey(
    typeof attrs.typeKey === "string"
      ? (attrs.typeKey as AgentTypeKey)
      : undefined,
  );

  if (threadId) {
    // Phase 4 (2026-08-02): 真源是 session-store.sessionMeta.threadTypes.
    useAgentSessionStore.getState().setSessionMeta((meta) => ({
      ...meta,
      threadTypes: { ...meta.threadTypes, [threadId]: typeKey },
    }));
    void useAgentSessionStore.getState().stopThreadRun(threadId);
  }

  if (instanceId) {
    useAgentSessionStore.getState().removeInstance(instanceId);
  }
}
