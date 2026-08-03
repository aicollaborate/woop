import type { AgentTypeKey } from "@/types/agent";
import { useAgentSessionStore } from "@features/agent/store/agent-session-store";
import type {
  AgentConversationInstance,
  AgentConversationSource,
} from "@features/agent/store/agent-conversation-store";

export function upsertAgentThreadCardConversationInstance(options: {
  instanceId: string;
  agentType: AgentTypeKey;
  title: string;
  threadId: string;
  source: AgentConversationSource;
  role: {
    memoId: string | null;
    name: string | null;
  };
}): {
  instanceId: string;
  instance: AgentConversationInstance;
} {
  const { instanceId, agentType, title, threadId, source, role } = options;

  // Phase 7 (2026-08-03): 改读 / 写真源 session-store.upsertInstance.
  // 旧双写路径 (conv-store.upsertInstance + setConversationRegistry)
  // 已合并到 session-store 内部, mirror 自动同步 conv-store.instances.
  const session = useAgentSessionStore.getState();
  const existing = session.getInstance(instanceId);
  const instance = session.upsertInstance(instanceId, {
    agentType,
    ...(existing?.title ? {} : { title }),
    threadId,
    source,
    role,
  });
  return { instanceId, instance };
}
