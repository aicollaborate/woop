import type { AgentTypeKey, RuntimeConfig } from "@/types/agent";
import type { LiveMessageState } from "@features/agent/store/chunk-result";

export type AgentConversationSource = {
  /**
   * `thread-card` ── 笔记内嵌的对话卡片 (source.memoId/documentPath 指向来源文档);
   * `dedicated` ── 从侧边栏「对话」列表独立创建的对话, 只归属 notebook, 无来源文档。
   */
  kind: "thread-card" | "dedicated";
  documentPath?: string | null;
  memoId?: string | null;
  notebookId?: string | null;
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
  snapshotSequence?: number | null;
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
