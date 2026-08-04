import type { AgentTypeKey } from "@/types/agent";

const CANONICAL_EXTERNAL_AGENTS = new Set<AgentTypeKey>([
  "codex",
  "claude",
  "hermes",
  "opencode",
]);

export function canonicalAgentMessageId(
  agentType: AgentTypeKey,
  runId: string,
  role: "user" | "assistant" | "reasoning" | "tool" | "tool-call" | "error",
  sourceMessageId: string | undefined,
): string | undefined {
  if (!sourceMessageId || !CANONICAL_EXTERNAL_AGENTS.has(agentType)) {
    return sourceMessageId;
  }
  if (sourceMessageId.startsWith("msg:")) return sourceMessageId;
  return `msg:${agentType}:${runId}:${role}:${sourceMessageId}`;
}

export function completedRunUserMessageId(
  agentType: AgentTypeKey | undefined,
  runId: string,
): string {
  const legacyId = `user-${runId}`;
  return agentType
    ? canonicalAgentMessageId(agentType, runId, "user", legacyId) ?? legacyId
    : legacyId;
}
