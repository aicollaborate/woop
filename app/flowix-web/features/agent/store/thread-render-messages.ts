import type { ChatMessage } from "@/types";
import type { AgentTypeKey } from "@/types/agent";
import { useAgentSessionStore } from "@features/agent/store/agent-session-store";

interface SelectRenderableThreadMessagesInput {
  typeKey: AgentTypeKey;
  threadId: string | null | undefined;
}

const EMPTY_MESSAGES: ChatMessage[] = [];

/**
 * Store-layer selector for the message list consumed by AgentThreadCard.
 *
 * Messages come directly from useAgentSessionStore.threadProjections[tid].
 *
 * Phase 5 (2026-08-03): external session fallback. 外部类型 (codex /
 * claude / opencode) 的 threadId 早期是 local id (e.g. "codex-local-abc"),
 * 解决后的 session id 写在 sessionMeta.externalSessionResolutions[localId].
 * applyResolvedSession 早 return 时 (e.g. threadInstance-binding mismatch),
 * projection 在 local id 永远空着, 卡 skeleton. 这里查 sessionMeta
 * 解析后用 session id 读 projection, 解决 stale-read 窗口.
 */
export function selectRenderableThreadMessages({
  typeKey: _typeKey,
  threadId,
}: SelectRenderableThreadMessagesInput): ChatMessage[] {
  if (!threadId) return EMPTY_MESSAGES;

  const session = useAgentSessionStore.getState();
  const resolvedSessionId =
    session.sessionMeta.externalSessionResolutions[threadId];
  const lookupId = resolvedSessionId ?? threadId;
  const projection = session.threadProjections[lookupId];
  return projection?.messages ?? EMPTY_MESSAGES;
}
