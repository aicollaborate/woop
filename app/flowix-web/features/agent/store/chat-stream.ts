import type {
  AgentCodexModel,
  AgentCodexReasoningEffort,
  AgentPermissionMode,
  AgentTypeKey,
  RuntimeConfig,
} from "@/types/agent";
import { buildAgentRuntimeConfig } from "@features/agent/runtime/agent-runtime-spec";
import { agentClient } from "@features/agent/store/agent-client";
import { useAgentAccessStore } from "@features/agent/store/agent-access-store";
import { resolveAuthorizedDefaultFiles } from "@/lib/agent-access-defaults";
import type { OutgoingUserPayload } from "@features/agent/store/user-message";

export interface DispatchChatStreamArgs {
  threadId: string;
  content: string;
  llmContent: string;
  runId: string;
  userPayload: OutgoingUserPayload;
  agentType: AgentTypeKey;
  permissionMode: AgentPermissionMode;
  codexModel: AgentCodexModel;
  codexReasoningEffort: AgentCodexReasoningEffort;
  agentRoleMemoId?: string;
  agentRoleName?: string;
  /** Runtime config snapshot from the conversation instance. */
  runtimeConfig?: RuntimeConfig;
  imagePaths?: string[];
  /** Product-owned title persisted before the runtime process starts. */
  conversationTitle?: string;
}

/**
 * 触发后端 `chat_stream` IPC ── fire-and-forget, 立刻返回, 后端错误/完成
 * 信号全走 `agent-chunk` 事件流, 由 dispatchAgentChunk / run-lifecycle 收敛。
 *
 * 真正的"错误捕获"留给 caller ── 这层只把 err 抛给 await 处, 让
 * send-message.ts 上的 try / catch 看到 IPC spawn 失败这种罕见情形
 * (正常情况下 chat_stream 是 Ok(()) 立即返回, 不会 throw)。
 */
export async function dispatchChatStream({
  threadId,
  content,
  llmContent,
  runId,
  userPayload,
  agentType,
  permissionMode,
  codexModel,
  codexReasoningEffort,
  agentRoleMemoId,
  agentRoleName,
  runtimeConfig: instanceRuntimeConfig,
  imagePaths,
  conversationTitle,
}: DispatchChatStreamArgs): Promise<void> {
  // 文件区域由「当前笔记本的资料列表 + 当前笔记本」实时推导 ── 不读
  // instance.files 快照。 notebookId 在创建 instance 时快照于
  // runtimeConfig.notebookId, 据此取该笔记本的资料默认; notebookPath
  // (= systemReminderDirectory) 既是无资料时的主空间, 也并入可读写集合。
  const notebookId = instanceRuntimeConfig?.notebookId;
  const defaultFiles = notebookId
    ? resolveAuthorizedDefaultFiles(useAgentAccessStore.getState().config, notebookId)
    : undefined;
  const runtimeConfig = buildAgentRuntimeConfig({
    typeKey: agentType,
    notebookPath: userPayload.systemReminderDirectory,
    permissionMode,
    codexModel,
    codexReasoningEffort,
    instanceRuntimeConfig,
    defaultFiles,
  });
  await agentClient.chatStream(threadId, {
    content,
    llmContent,
    runId,
    systemReminderDirectory: userPayload.systemReminderDirectory,
    systemReminderDocumentPath: userPayload.systemReminderDocumentPath,
    agentType,
    runtimeConfig,
    agentRoleMemoId,
    agentRoleName,
    imagePaths,
    conversationTitle,
  });
}
