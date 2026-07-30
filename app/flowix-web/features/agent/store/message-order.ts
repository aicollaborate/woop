import type { ChatMessage } from "@/types";

function messageOrderTimestamp(message: ChatMessage): number {
  if (Number.isFinite(message.sourceTimestamp)) {
    return message.sourceTimestamp!;
  }
  const parsed = Date.parse(message.timestamp);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

export function compareAgentMessageOrder(
  left: ChatMessage,
  right: ChatMessage,
): number {
  const timestampDelta =
    messageOrderTimestamp(left) - messageOrderTimestamp(right);
  if (timestampDelta !== 0) return timestampDelta;

  if (left.sourceSequence !== undefined && right.sourceSequence !== undefined) {
    const sequenceDelta = left.sourceSequence - right.sourceSequence;
    if (sequenceDelta !== 0) return sequenceDelta;
  }

  if (
    left.sourceSubsequence !== undefined &&
    right.sourceSubsequence !== undefined
  ) {
    return left.sourceSubsequence - right.sourceSubsequence;
  }

  return 0;
}

export function insertAgentMessageBySourceOrder(
  messages: ChatMessage[],
  message: ChatMessage,
): ChatMessage[] {
  if (
    message.sourceTimestamp === undefined &&
    message.sourceSequence === undefined
  ) {
    return [...messages, message];
  }

  const insertAt = messages.findIndex(
    (existing) => compareAgentMessageOrder(message, existing) < 0,
  );
  if (insertAt < 0) return [...messages, message];
  return [...messages.slice(0, insertAt), message, ...messages.slice(insertAt)];
}
