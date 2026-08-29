import type { ChatMessage } from "@/types";
import { completedRunUserMessageId } from "@features/agent/events/message-identity";

export interface CodexLiveTurnCache {
  runId: string;
  /** Codex turn id once any event of the run carried it; anchors the slice. */
  turnId?: string;
  messages: ChatMessage[];
  status: "running" | "awaiting_snapshot";
  updatedAt: number;
}

export function liveTurnMessages(
  messages: ChatMessage[],
  runId: string,
  turnId?: string,
): ChatMessage[] {
  const anchorId = completedRunUserMessageId("codex", runId);
  const anchor = messages.findIndex(
    (message) =>
      message.id === anchorId ||
      message.id === `user-${runId}` ||
      // Once the provider userMessage item adopts the optimistic row, the
      // run boundary is the turn-scoped user row, not the run-scoped id.
      (!!turnId && message.role === "user" && message.codexTurnId === turnId),
  );
  return anchor >= 0 ? messages.slice(anchor) : [];
}
