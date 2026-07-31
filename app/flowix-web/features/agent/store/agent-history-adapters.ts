import type { ChatMessage, ThreadListItem } from "@/types";
import type { AgentTypeKey } from "@/types/agent";
import { agentClient } from "@features/agent/store/agent-client";

export interface ThreadHistoryPage {
  messages: ChatMessage[];
  oldestSequence: number | null;
  hasMore: boolean;
}

export interface AgentHistoryAdapter {
  readonly typeKey: AgentTypeKey;
  readonly externalSessionBacked?: boolean;
  listThreads(): Promise<ThreadListItem[]>;
  getInitialHistory(threadId: string, limit: number): Promise<ThreadHistoryPage>;
  getFullHistory(threadId: string): Promise<ChatMessage[]>;
  getPage(
    threadId: string,
    beforeSequence: number | null,
    limit: number,
  ): Promise<ThreadHistoryPage>;
}

function createFlowixHistoryAdapter(): AgentHistoryAdapter {
  return {
    typeKey: "flowix",
    listThreads: () => agentClient.listThreads(),
    async getFullHistory(threadId) {
      return (await agentClient.getThread(threadId)).messages;
    },
    getInitialHistory: (threadId, limit) =>
      agentClient.getThreadPage(threadId, null, limit),
    getPage: (threadId, beforeSequence, limit) =>
      agentClient.getThreadPage(threadId, beforeSequence, limit),
  };
}

function createCodexHistoryAdapter(): AgentHistoryAdapter {
  return {
    typeKey: "codex",
    externalSessionBacked: true,
    listThreads: () => agentClient.listCodexThreads(),
    async getFullHistory(threadId) {
      return (await agentClient.getCodexThread(threadId)).messages;
    },
    getInitialHistory: (threadId, limit) =>
      agentClient.getCodexThreadPage(threadId, null, limit),
    getPage: (threadId, beforeSequence, limit) =>
      agentClient.getCodexThreadPage(threadId, beforeSequence, limit),
  };
}

function createClaudeHistoryAdapter(): AgentHistoryAdapter {
  return {
    typeKey: "claude",
    externalSessionBacked: true,
    listThreads: () => agentClient.listClaudeThreads(),
    async getFullHistory(threadId) {
      return (await agentClient.getClaudeThreadPage(threadId, null, 50)).messages;
    },
    getInitialHistory: (threadId, limit) =>
      agentClient.getClaudeThreadPage(threadId, null, limit),
    getPage: (threadId, beforeSequence, limit) =>
      agentClient.getClaudeThreadPage(threadId, beforeSequence, limit),
  };
}

function createHermesHistoryAdapter(): AgentHistoryAdapter {
  return {
    typeKey: "hermes",
    externalSessionBacked: true,
    listThreads: () => agentClient.listHermesThreads(),
    async getFullHistory(threadId) {
      return (await agentClient.getHermesThread(threadId)).messages;
    },
    getInitialHistory: (threadId, limit) =>
      agentClient.getHermesThreadPage(threadId, null, limit),
    getPage: (threadId, beforeSequence, limit) =>
      agentClient.getHermesThreadPage(threadId, beforeSequence, limit),
  };
}

function createLocalAgentHistoryAdapter(typeKey: AgentTypeKey): AgentHistoryAdapter {
  return {
    typeKey,
    listThreads: () => agentClient.listLocalAgentThreads(typeKey),
    async getFullHistory(threadId) {
      return (await agentClient.getThread(threadId)).messages;
    },
    getInitialHistory: (threadId, limit) =>
      agentClient.getThreadPage(threadId, null, limit),
    getPage: (threadId, beforeSequence, limit) =>
      agentClient.getThreadPage(threadId, beforeSequence, limit),
  };
}

function createOpenCodeHistoryAdapter(): AgentHistoryAdapter {
  return {
    typeKey: "opencode",
    externalSessionBacked: true,
    listThreads: () => agentClient.listOpenCodeThreads(),
    async getFullHistory(threadId) {
      return (await agentClient.getOpenCodeThreadPage(threadId, null, 50)).messages;
    },
    getInitialHistory: (threadId, limit) =>
      agentClient.getOpenCodeThreadPage(threadId, null, limit),
    getPage: (threadId, beforeSequence, limit) =>
      agentClient.getOpenCodeThreadPage(threadId, beforeSequence, limit),
  };
}

const historyAdapters: Partial<Record<AgentTypeKey, AgentHistoryAdapter>> = {
  flowix: createFlowixHistoryAdapter(),
  // Codex history is materialized by the backend from compact DB snapshots.
  // The rollout transcript is a display-only fallback when DB events are empty.
  codex: createCodexHistoryAdapter(),
  claude: createClaudeHistoryAdapter(),
  hermes: createHermesHistoryAdapter(),
  // OpenCode 的唯一历史源是紧凑的 agent_external_events。后端以完整用户
  // 回合分页并将 snapshot events 物化为消息，前端不重放流式 delta。
  opencode: createOpenCodeHistoryAdapter(),
};

export function getAgentHistoryAdapter(typeKey: AgentTypeKey): AgentHistoryAdapter {
  return historyAdapters[typeKey] ?? createLocalAgentHistoryAdapter(typeKey);
}
