import type { AgentTypeKey } from "@/types/agent";
import { useAgentSessionStore } from "@features/agent/store/agent-session-store";
import type {
  AgentConversationInstance,
  AgentConversationSource,
} from "@features/agent/store/agent-conversation-types";

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

  // Read and update the canonical conversation registry.
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
