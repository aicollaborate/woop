import type { AgentTypeKey } from "@/types/agent";
import { useAgentSessionStore } from "@features/agent/store/agent-session-store";
import type {
  AgentConversationInstance,
  AgentConversationSource,
} from "@features/agent/store/agent-conversation-types";
import type { RuntimeConfig } from "@/types/agent";

export async function upsertAgentThreadCardConversationInstance(options: {
  instanceId: string;
  agentType: AgentTypeKey;
  title: string;
  threadId: string;
  source: AgentConversationSource;
  role: {
    memoId: string | null;
    name: string | null;
  };
  runtimeConfig?: RuntimeConfig | null;
}): Promise<{
  instanceId: string;
  instance: AgentConversationInstance;
}> {
  const { instanceId, agentType, title, threadId, source, role, runtimeConfig } = options;

  // Read and update the canonical conversation registry.
  const session = useAgentSessionStore.getState();
  const instance = await session.initializeThread(instanceId, {
    agentType,
    title,
    threadId,
    source,
    role,
    runtimeConfig,
  });
  return { instanceId, instance };
}
