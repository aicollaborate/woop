import { describe, expect, it, vi } from "vitest";
import type { AgentEventMapperState } from "./agent-event-mapper";
import { mapAgentChunkToEvent } from "./agent-event-mapper";

function state(
  partial: Partial<AgentEventMapperState> = {},
): AgentEventMapperState {
  return {
    threadTypes: {},
    threadStates: {},
    externalSessionResolutions: {},
    ...partial,
  };
}

describe("agent event mapper", () => {
  it("maps persisted user messages with their stable ordering anchor", () => {
    const event = mapAgentChunkToEvent(
      {
        kind: "user_message",
        thread_id: "claude-thread",
        id: "user-1",
        text: "question",
        timestamp: 456,
        agent_type: "claude",
        run_id: "run-1",
      },
      state(),
      () => 123,
    );

    expect(event).toMatchObject({
      kind: "user_message",
      id: "msg:claude:run-1:user:user-1",
      text: "question",
      messageId: "msg:claude:run-1:user:user-1",
      sourceTimestamp: 456,
      sourceSequence: 0,
    });
  });

  it("maps Flowix text chunks to streaming deltas", () => {
    const event = mapAgentChunkToEvent(
      {
        kind: "text",
        thread_id: "flowix-thread",
        text: "hello",
        agent_type: "flowix",
        run_id: "run-1",
      },
      state(),
      () => 123,
    );

    expect(event).toMatchObject({
      kind: "text_delta",
      threadId: "flowix-thread",
      runId: "run-1",
      timestamp: 123,
      text: "hello",
    });
  });

  it("maps Codex text chunks to final messages", () => {
    const event = mapAgentChunkToEvent(
      {
        kind: "text",
        thread_id: "codex-thread",
        text: "complete answer",
        agent_type: "codex",
        run_id: "run-1",
        message_id: "assistant-item-1",
        message_phase: "completed",
        content_mode: "snapshot",
        source_timestamp: 456,
        source_sequence: 7,
        source_subsequence: 0,
      },
      state(),
      () => 123,
    );

    expect(event).toMatchObject({
      kind: "final_message",
      threadId: "codex-thread",
      agentType: "codex",
      text: "complete answer",
      messageId: "msg:codex:run-1:assistant:assistant-item-1",
      messagePhase: "completed",
      contentMode: "snapshot",
      sourceTimestamp: 456,
      sourceSequence: 7,
      sourceSubsequence: 0,
    });
  });

  it("keeps session_resolved routed to the local thread id", () => {
    const event = mapAgentChunkToEvent(
      {
        kind: "session_resolved",
        thread_id: "codex-local-inst-1",
        session_id: "codex-real-session",
        agent_type: "codex",
        run_id: "run-1",
      },
      state({
        externalSessionResolutions: {
          "codex-local-inst-1": "codex-real-session",
        },
      }),
      () => 123,
    );

    expect(event).toMatchObject({
      kind: "session_resolved",
      threadId: "codex-local-inst-1",
      sessionId: "codex-real-session",
    });
  });

  it("routes later chunks to the resolved external session id", () => {
    const event = mapAgentChunkToEvent(
      {
        kind: "stream_end",
        thread_id: "codex-local-inst-1",
        reason: null,
        agent_type: "codex",
        run_id: "run-1",
      },
      state({
        externalSessionResolutions: {
          "codex-local-inst-1": "codex-real-session",
        },
      }),
      () => 123,
    );

    expect(event).toMatchObject({
      kind: "stream_end",
      threadId: "codex-real-session",
      runId: "run-1",
    });
  });

  it("reuses the active run id when chunks omit run_id", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    const event = mapAgentChunkToEvent(
      {
        kind: "reasoning",
        thread_id: "thread-1",
        text: "thinking",
        agent_type: "flowix",
      },
      state({
        threadStates: {
          "thread-1": { activeRunId: "active-run" },
        },
      }),
      () => 123,
    );

    expect(event.runId).toBe("active-run");
    vi.restoreAllMocks();
  });

  it("folds Claude reasoning from multiple provider messages into one run id", () => {
    const mapperState = state();
    const first = mapAgentChunkToEvent(
      {
        kind: "reasoning",
        thread_id: "claude-thread",
        text: "first",
        agent_type: "claude",
        run_id: "run-1",
        message_id: "reasoning-provider-message-1-block-0",
      },
      mapperState,
    );
    const second = mapAgentChunkToEvent(
      {
        kind: "reasoning",
        thread_id: "claude-thread",
        text: "second",
        agent_type: "claude",
        run_id: "run-1",
        message_id: "reasoning-provider-message-2-block-0",
      },
      mapperState,
    );

    expect(first.messageId).toBe(
      "msg:claude:run-1:reasoning:reasoning-run-1",
    );
    expect(second.messageId).toBe(first.messageId);
  });

  it("drops legacy per-delta Claude envelope UUIDs for contiguous text folding", () => {
    const event = mapAgentChunkToEvent(
      {
        kind: "text",
        thread_id: "claude-thread",
        text: "fragment",
        agent_type: "claude",
        run_id: "run-1",
        message_id:
          "assistant-d9193ae4-86b5-47a6-9e85-1bb4ef0acc1c-block-1",
        message_phase: "updated",
        content_mode: "delta",
      },
      state(),
    );

    expect(event).toMatchObject({
      kind: "text_delta",
      agentType: "claude",
      text: "fragment",
    });
    expect(event.messageId).toBeUndefined();
  });

  it("preserves stable Claude provider message ids", () => {
    const event = mapAgentChunkToEvent(
      {
        kind: "text",
        thread_id: "claude-thread",
        text: "fragment",
        agent_type: "claude",
        run_id: "run-1",
        message_id: "assistant-06bbbb1512785f3d1da3e1f495c31702-block-1",
        message_phase: "updated",
        content_mode: "delta",
      },
      state(),
    );

    expect(event.messageId).toBe(
      "msg:claude:run-1:assistant:assistant-06bbbb1512785f3d1da3e1f495c31702-block-1",
    );
  });

  it("adds a stable tool display summary without requiring UI schema knowledge", () => {
    const event = mapAgentChunkToEvent(
      {
        kind: "tool_call",
        thread_id: "codex-thread",
        id: "tool-1",
        name: "web_search",
        input: { query: "OpenAI latest model" },
        agent_type: "codex",
        run_id: "run-1",
      },
      state(),
      () => 123,
    );

    expect(event).toMatchObject({
      kind: "tool_call",
      name: "web_search",
      input: { query: "OpenAI latest model" },
      display: {
        summary: "OpenAI latest model",
        title: "OpenAI latest model",
        kind: "search",
      },
    });
  });
});
