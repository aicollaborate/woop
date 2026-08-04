import type { AgentTypeKey } from "@/types/agent";
import { normalizeAgentTypeKey } from "@/lib/agent-types";
import { useAgentSessionStore } from "@features/agent/store/agent-session-store";
import { buildInitialInstanceRuntimeConfig } from "@features/agent/store/initial-runtime-config";
import type { AgentConversationInstance } from "@features/agent/store/agent-conversation-types";

export interface AgentThreadCardCleanupAttrs {
  threadId?: unknown;
  instanceId?: unknown;
  typeKey?: unknown;
}

const MAX_UNDOABLE_REMOVED_INSTANCES = 100;
const removedInstances = new Map<string, AgentConversationInstance | null>();

export function restoreRemovedAgentThreadCardInstance(
  attrs: AgentThreadCardCleanupAttrs & Record<string, unknown>,
): void {
  const instanceId =
    typeof attrs.instanceId === "string" ? attrs.instanceId.trim() : "";
  if (!instanceId || !removedInstances.has(instanceId)) return;
  const snapshot = removedInstances.get(instanceId) ?? undefined;
  removedInstances.delete(instanceId);
  const typeKey = normalizeAgentTypeKey(
    typeof attrs.typeKey === "string"
      ? (attrs.typeKey as AgentTypeKey)
      : undefined,
  );
  useAgentSessionStore.getState().upsertInstance(instanceId, {
    agentType: snapshot?.agentType ?? typeKey,
    title:
      snapshot?.title ?? (typeof attrs.title === "string" ? attrs.title : ""),
    threadId:
      snapshot?.threadId ??
      (typeof attrs.threadId === "string" ? attrs.threadId : null),
    source: snapshot?.source ?? { kind: "thread-card" },
    role: snapshot?.role ?? {
      memoId:
        typeof attrs.agentRoleMemoId === "string"
          ? attrs.agentRoleMemoId
          : null,
      name:
        typeof attrs.agentRoleName === "string" ? attrs.agentRoleName : null,
    },
    runtimeConfig:
      snapshot?.runtimeConfig ?? buildInitialInstanceRuntimeConfig(typeKey),
  });
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
    const instance = useAgentSessionStore.getState().getInstance(instanceId);
    removedInstances.set(instanceId, instance);
    while (removedInstances.size > MAX_UNDOABLE_REMOVED_INSTANCES) {
      const oldest = removedInstances.keys().next().value as string | undefined;
      if (!oldest) break;
      removedInstances.delete(oldest);
    }
    useAgentSessionStore.getState().removeInstance(instanceId);
  }
}
