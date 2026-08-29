import type { ChatMessage } from "@/types";
import { completedRunUserMessageId } from "@features/agent/events/message-identity";

export interface CodexLiveTurnCache {
  runId: string;
  messages: ChatMessage[];
  status: "running" | "awaiting_snapshot";
  updatedAt: number;
}

export function liveTurnMessages(
  messages: ChatMessage[],
  runId: string,
): ChatMessage[] {
  const anchorId = completedRunUserMessageId("codex", runId);
  const anchor = messages.findIndex((message) =>
    message.id === anchorId || message.id === `user-${runId}`,
  );
  return anchor >= 0 ? messages.slice(anchor) : [];
}
