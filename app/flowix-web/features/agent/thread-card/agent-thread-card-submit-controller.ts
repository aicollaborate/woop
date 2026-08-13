import type { AgentTypeKey } from "@/types/agent";
import type { AgentConversationSource } from "@features/agent/store/agent-conversation-types";
import { useAgentSessionStore } from "@features/agent/store/agent-session-store";
import { createConversationInstanceId } from "@features/agent/store/conversation-slice";
import { buildInitialInstanceRuntimeConfig } from "@features/agent/store/initial-runtime-config";
import { ensureConversationWorkspaceSnapshot } from "@features/agent/runtime/workspace-snapshot";
import { ensureAgentThreadCardThread } from "@features/agent/thread-card/agent-thread-card-submit";
import { upsertAgentThreadCardConversationInstance } from "@features/agent/thread-card/runtime/thread-card-conversation";

export interface SubmitAgentThreadCardConversationInput {
  prompt: string;
  imagePaths?: string[];
  fallbackTitle: string;
  typeKey: AgentTypeKey;
  currentThreadId: string | null;
  currentInstanceId: string | null;
  currentTitle: string;
  runtimeHandleId: string;
  source: AgentConversationSource;
  role: {
    memoId: string | null;
    name: string | null;
  };
  isFirstMessage: boolean;
  documentContext: string;
  buildTitle: (prompt: string, fallback: string) => string;
  loadAgentRoleBody: (memoId: string) => Promise<string | null>;
  onThreadBound: (binding: {
    instanceId: string;
    threadId: string;
    typeKey: AgentTypeKey;
  }) => void;
}

export async function submitAgentThreadCardConversation(
  input: SubmitAgentThreadCardConversationInput,
): Promise<void> {
  let nextThreadId = input.currentThreadId;
  let nextInstanceId = input.currentInstanceId;
  let nextTitle =
    input.currentTitle || input.buildTitle(input.prompt, input.fallbackTitle);
  let nextTypeKey = input.typeKey;

  if (!nextInstanceId) {
    nextInstanceId = createConversationInstanceId();
  }

  if (!nextThreadId) {
    const ensured = await ensureAgentThreadCardThread({
      prompt: input.prompt,
      fallbackTitle: input.fallbackTitle,
      typeKey: input.typeKey,
      currentThreadId: input.currentThreadId,
      runtimeHandleId: input.runtimeHandleId,
      instanceId: nextInstanceId,
      buildTitle: input.buildTitle,
    });

    if (ensured) {
      nextThreadId = ensured.threadId;
      nextTitle = ensured.title;
      nextTypeKey = ensured.typeKey;
    }
  }

  if (!nextThreadId) {
    throw new Error("Agent thread id was not created");
  }

  const conversation = await upsertAgentThreadCardConversationInstance({
    instanceId: nextInstanceId,
    agentType: nextTypeKey,
    title: nextTitle,
    threadId: nextThreadId,
    source: input.source,
    role: input.role,
    runtimeConfig: buildInitialInstanceRuntimeConfig(nextTypeKey),
  });
  nextInstanceId = conversation.instanceId;
  // Freeze the effective cwd / add-dir / notebook paths immediately before
  // the first run. Existing and migrated conversations reuse this snapshot.
  const runtimeConfig = ensureConversationWorkspaceSnapshot(nextInstanceId);

  const roleBody =
    input.isFirstMessage && input.role.memoId
      ? await input.loadAgentRoleBody(input.role.memoId)
      : null;

  const sendPromise = useAgentSessionStore
    .getState()
    .sendMessageToThread(nextThreadId, input.prompt, nextTypeKey, {
      instanceId: nextInstanceId,
      conversationTitle: nextTitle,
      currentNoteContent: input.documentContext,
      agentRoleMemoId: input.role.memoId ?? undefined,
      agentRoleName: input.role.name ?? undefined,
      isFirstMessage: input.isFirstMessage,
      agentRoleBody: roleBody,
      runtimeConfig,
      imagePaths: input.imagePaths,
    });

  input.onThreadBound({
    instanceId: nextInstanceId,
    threadId: nextThreadId,
    typeKey: nextTypeKey,
  });

  await sendPromise;
}
