import type { AgentChunk, AgentEvent, AgentTypeKey } from "@/types/agent";
import {
  normalizeAgentTypeKey,
  supportsTextStreaming,
} from "@/lib/agent-types";
import {
  resolveExternalChunkAgentType,
  resolveExternalChunkThreadId,
} from "@features/agent/store/external-session";
import { createAgentToolDisplay } from "@features/agent/tool-display";
import { canonicalAgentMessageId } from "@features/agent/events/message-identity";

interface AgentEventMapperThreadState {
  activeRunId: string | null;
}

export interface AgentEventMapperState {
  threadTypes: Record<string, AgentTypeKey>;
  threadStates: Record<string, AgentEventMapperThreadState | undefined>;
  externalSessionResolutions: Record<string, string>;
}

export function createRunId(threadId: string): string {
  return `run-${threadId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveChunkRunId(
  chunk: AgentChunk,
  threadId: string,
  st: AgentEventMapperThreadState | undefined,
): string {
  return chunk.run_id ?? st?.activeRunId ?? createRunId(threadId);
}

const CLAUDE_ENVELOPE_TEXT_MESSAGE_ID =
  /^assistant-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-block-\d+$/i;

function resolveTextMessageId(
  agentType: AgentTypeKey,
  messageId: string | undefined,
  contentMode: "delta" | "snapshot" | undefined,
): string | undefined {
  // Older Claude stream adapters used the stream envelope UUID, which changes
  // on every delta. Dropping only that known-bad delta id lets pendingAssistantId
  // join contiguous text while tool calls still form an explicit boundary.
  if (
    agentType === "claude" &&
    contentMode === "delta" &&
    messageId &&
    CLAUDE_ENVELOPE_TEXT_MESSAGE_ID.test(messageId)
  ) {
    return undefined;
  }
  return messageId;
}

export function mapAgentChunkToEvent(
  chunk: AgentChunk,
  state: AgentEventMapperState,
  now: () => number = Date.now,
): AgentEvent {
  const messageMetadata = chunk as AgentChunk & {
    message_id?: string;
    message_phase?: "started" | "updated" | "completed";
    content_mode?: "delta" | "snapshot";
    source_timestamp?: number;
    source_sequence?: number;
    source_subsequence?: number;
  };
  const sourceThreadId = chunk.thread_id;
  const threadId = resolveExternalChunkThreadId(
    chunk,
    state.externalSessionResolutions,
  );
  const st = state.threadStates[threadId];
  const base = {
    agentType: normalizeAgentTypeKey(
      resolveExternalChunkAgentType(
        chunk,
        sourceThreadId,
        threadId,
        state.threadTypes,
      ),
    ),
    threadId,
    runId: resolveChunkRunId(chunk, threadId, st),
    timestamp: now(),
    messageId: messageMetadata.message_id,
    messagePhase: messageMetadata.message_phase,
    contentMode: messageMetadata.content_mode,
    sourceTimestamp: messageMetadata.source_timestamp,
    sourceSequence: messageMetadata.source_sequence,
    sourceSubsequence: messageMetadata.source_subsequence,
  };

  switch (chunk.kind) {
    case "user_message":
      return {
        ...base,
        kind: "user_message",
        id:
          canonicalAgentMessageId(
            base.agentType,
            base.runId,
            "user",
            chunk.id,
          ) ?? chunk.id,
        text: chunk.text,
        messageId:
          canonicalAgentMessageId(
            base.agentType,
            base.runId,
            "user",
            chunk.id,
          ) ?? chunk.id,
        sourceTimestamp: chunk.timestamp,
        sourceSequence: 0,
        sourceSubsequence: 0,
      };
    case "text": {
      const messageId = canonicalAgentMessageId(
        base.agentType,
        base.runId,
        "assistant",
        resolveTextMessageId(base.agentType, base.messageId, base.contentMode),
      );
      return supportsTextStreaming(base.agentType)
        ? { ...base, kind: "text_delta", text: chunk.text, messageId }
        : { ...base, kind: "final_message", text: chunk.text, messageId };
    }
    case "reasoning":
      return {
        ...base,
        kind: "reasoning_delta",
        text: chunk.text,
        messageId: canonicalAgentMessageId(
          base.agentType,
          base.runId,
          "reasoning",
          base.agentType === "claude" &&
            !base.messageId?.startsWith("msg:")
            ? `reasoning-${base.runId}`
            : base.messageId,
        ),
      };
    case "tool_call":
      return {
        ...base,
        kind: "tool_call",
        messageId: canonicalAgentMessageId(
          base.agentType,
          base.runId,
          "tool",
          base.messageId,
        ),
        toolCallId:
          canonicalAgentMessageId(
            base.agentType,
            base.runId,
            "tool-call",
            chunk.id,
          ) ??
          chunk.id,
        name: chunk.name,
        input: chunk.input,
        display: createAgentToolDisplay({
          agentType: base.agentType,
          toolName: chunk.name,
          input: chunk.input,
        }),
      };
    case "tool_result":
      return {
        ...base,
        kind: "tool_result",
        messageId: canonicalAgentMessageId(
          base.agentType,
          base.runId,
          "tool",
          base.messageId,
        ),
        toolCallId:
          canonicalAgentMessageId(
            base.agentType,
            base.runId,
            "tool-call",
            chunk.id,
          ) ??
          chunk.id,
        name: chunk.name,
        result: chunk.result,
      };
    case "error":
      return { ...base, kind: "error", message: chunk.message };
    case "stream_start":
      return {
        ...base,
        kind: "stream_start",
        // 通用 metadata 协议 ── 透传 model / reasoning_effort 到 event,
        // 后续由 applyRunStarted 写入 runs[runId].model。
        model: chunk.model,
        reasoning_effort: chunk.reasoning_effort,
      };
    case "stream_end":
      return { ...base, kind: "stream_end", reason: chunk.reason };
    case "session_resolved":
      return { ...base, kind: "session_resolved", sessionId: chunk.session_id };
    case "usage":
      // 通用 metadata 协议 ── 透传 token 用量到 event,后续由 reducer 累加。
      // 嵌套 usage / status_info 对象直接透传,reducer 做字段级累加。
      return {
        ...base,
        kind: "usage",
        modelId: chunk.model_id ?? null,
        lastRunAt: chunk.last_run_at ?? null,
        usage: chunk.usage ?? null,
        statusInfo: chunk.status_info ?? null,
      };
  }
}
