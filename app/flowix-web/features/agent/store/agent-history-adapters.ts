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
      return (await agentClient.getClaudeThread(threadId)).messages;
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

const historyAdapters: Partial<Record<AgentTypeKey, AgentHistoryAdapter>> = {
  flowix: createFlowixHistoryAdapter(),
  codex: createCodexHistoryAdapter(),
  claude: createClaudeHistoryAdapter(),
  hermes: createHermesHistoryAdapter(),
  // OpenCode ACP 的历史由 `OpenCodeAcpManager` 通过 `persist_external_chunk`
  // 写入 ThreadManager, 与本地 thread store 同一条管道 ── 复用
  // `createLocalAgentHistoryAdapter` 走标准 thread 存储, 不需要单独 list /
  // getThread IPC。session id 由 `getOpenCodeSessionId` IPC 在恢复时反查。
  opencode: createLocalAgentHistoryAdapter("opencode"),
};

export function getAgentHistoryAdapter(typeKey: AgentTypeKey): AgentHistoryAdapter {
  return historyAdapters[typeKey] ?? createLocalAgentHistoryAdapter(typeKey);
}
