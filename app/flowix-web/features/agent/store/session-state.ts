import type {
  AgentCodexModel,
  AgentCodexReasoningEffort,
  AgentPermissionMode,
  AgentTypeKey,
} from "@/types/agent";
import type { ThreadListItem } from "@/types";
import type { AgentConversationInstance } from "@features/agent/store/agent-conversation-types";

export interface AgentSessionMeta {
  activeThreadIds: Partial<Record<AgentTypeKey, string | undefined>>;
  activeAgentTypeKey: AgentTypeKey;
  threadTypes: Record<string, AgentTypeKey>;
  threadLists: Partial<Record<AgentTypeKey, ThreadListItem[]>>;
  currentThreadTitles: Partial<Record<AgentTypeKey, string | undefined>>;
  externalSessionResolutions: Record<string, string>;
  lastRunningRunsReconciledAt: number | null;
  settings: {
    agentPermissionMode: AgentPermissionMode;
    agentCodexModel: AgentCodexModel;
    agentCodexReasoningEffort: AgentCodexReasoningEffort;
  };
}

export const DEFAULT_AGENT_SESSION_META: AgentSessionMeta = {
  activeThreadIds: {},
  activeAgentTypeKey: "flowix",
  threadTypes: {},
  threadLists: {},
  currentThreadTitles: {},
  externalSessionResolutions: {},
  lastRunningRunsReconciledAt: null,
  settings: {
    agentPermissionMode: "danger-full-access",
    agentCodexModel: "inherit",
    agentCodexReasoningEffort: "medium",
  },
};

export interface AgentConversationRegistry {
  instances: Record<string, AgentConversationInstance>;
}

export const EMPTY_AGENT_CONVERSATION_REGISTRY: AgentConversationRegistry = {
  instances: {},
};
