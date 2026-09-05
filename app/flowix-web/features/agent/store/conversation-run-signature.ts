import type { ThreadProjection } from "@features/agent/store/session-reducer";

/**
 * The list only needs these lifecycle fields. Message/progress projection
 * changes must not look like a conversation-list change.
 */
const FIELD_SEPARATOR = "\u001f";
export const EMPTY_CONVERSATION_RUN_SIGNATURE = "-";

export function getConversationRunSignature(
  projection: ThreadProjection | undefined,
): string {
  if (!projection) return EMPTY_CONVERSATION_RUN_SIGNATURE;
  const activeRun = projection.runs.activeRunId
    ? projection.runs.runs[projection.runs.activeRunId]
    : undefined;
  const status = activeRun?.status ?? projection.runs.lastRun?.status ?? EMPTY_CONVERSATION_RUN_SIGNATURE;
  const runId = activeRun?.runId ?? projection.runs.lastRun?.runId ?? EMPTY_CONVERSATION_RUN_SIGNATURE;
  const startedAt = activeRun?.startedAt ?? projection.runs.lastRun?.startedAt ?? 0;
  const currentTool = activeRun?.currentTool ?? EMPTY_CONVERSATION_RUN_SIGNATURE;
  return `${status}${FIELD_SEPARATOR}${runId}${FIELD_SEPARATOR}${startedAt}${FIELD_SEPARATOR}${currentTool}`;
}

export function splitConversationRunSignature(signature: string): {
  status: "running" | "completed" | "failed" | "cancelled" | null;
  runId: string | null;
  startedAt: number;
  currentTool: string | null;
} {
  if (!signature || signature === EMPTY_CONVERSATION_RUN_SIGNATURE) {
    return { status: null, runId: null, startedAt: 0, currentTool: null };
  }
  const [status, runId, startedAt, currentTool] = signature.split(FIELD_SEPARATOR);
  return {
    status: status === EMPTY_CONVERSATION_RUN_SIGNATURE
      ? null
      : status as "running" | "completed" | "failed" | "cancelled",
    runId: runId === EMPTY_CONVERSATION_RUN_SIGNATURE ? null : runId,
    startedAt: Number(startedAt) || 0,
    currentTool: currentTool === EMPTY_CONVERSATION_RUN_SIGNATURE ? null : currentTool,
  };
}
