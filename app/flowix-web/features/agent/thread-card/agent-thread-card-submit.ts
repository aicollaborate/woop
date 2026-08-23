import type { AgentTypeKey } from '@/types/agent';
import { getAgentType } from '@/lib/agent-types';
import { stripSystemBlock } from '@features/agent/message';
import { beginExternalAgentThreadCardRun } from '@features/agent/services/external-agent-runtime-service';

export interface EnsureAgentThreadCardThreadInput {
  prompt: string;
  fallbackTitle: string;
  typeKey: AgentTypeKey;
  currentThreadId: string | null;
  runtimeHandleId: string;
  instanceId: string;
  buildTitle: (prompt: string, fallback: string) => string;
}
export interface EnsureAgentThreadCardThreadResult {
  threadId: string;
  title: string;
  typeKey: AgentTypeKey;
}

export async function ensureAgentThreadCardThread(
  input: EnsureAgentThreadCardThreadInput
): Promise<EnsureAgentThreadCardThreadResult | null> {
  if (input.currentThreadId) {
    return null;
  }

  const fallbackTitle = stripSystemBlock(input.fallbackTitle).replace(/\s+/g, ' ').trim();
  const nextTitle = stripSystemBlock(input.buildTitle(input.prompt, input.fallbackTitle))
    .replace(/\s+/g, ' ')
    .trim() || fallbackTitle;
  const type = getAgentType(input.typeKey);
  return {
    threadId: beginExternalAgentThreadCardRun(
      input.runtimeHandleId,
      type.key,
      input.currentThreadId,
      input.instanceId,
    ),
    title: nextTitle,
    typeKey: type.key,
  };
}
