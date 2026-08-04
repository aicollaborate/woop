import type { AgentTypeKey, RuntimeConfig } from "@/types/agent";
import type { LiveMessageState } from "@features/agent/store/chunk-result";

export type AgentConversationSource = {
  kind: "thread-card";
  documentPath?: string | null;
  memoId?: string | null;
};

export interface AgentConversationRole {
  memoId?: string | null;
  name?: string | null;
}

export interface AgentConversationInstance {
  instanceId: string;
  agentType: AgentTypeKey;
  title: string;
  threadId: string | null;
  runtimeConfig?: RuntimeConfig | null;
  /** Observability only. The backend is the sole writer and runtime authority. */
  readonly frozenCwd?: string | null;
  source: AgentConversationSource;
  role?: AgentConversationRole | null;
  createdAt: number;
  updatedAt: number;
}

export interface AgentConversationMessageState extends LiveMessageState {
  oldestSequence: number | null;
  hasMoreHistory: boolean;
  loadingInitial: boolean;
  loadingMore: boolean;
}

export interface CreateAgentConversationInstanceInput {
  agentType: AgentTypeKey;
  title: string;
  threadId?: string | null;
  runtimeConfig?: RuntimeConfig | null;
  source: AgentConversationSource;
  role?: AgentConversationRole;
}
