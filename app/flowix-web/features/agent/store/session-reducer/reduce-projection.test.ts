import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@/types/agent";
import {
  emptyProjection,
  reduceProjection,
} from "@features/agent/store/session-reducer";

function event<K extends AgentEvent["kind"]>(
  kind: K,
  payload: Omit<Extract<AgentEvent, { kind: K }>, "kind">,
): AgentEvent {
  return { kind, ...payload } as AgentEvent;
}

const userMessage = (text: string, id: string): AgentEvent =>
  event("user_message", {
    agentType: "flowix",
    threadId: "t1",
    runId: "r1",
    timestamp: 1000,
    text,
    id,
    sourceTimestamp: 1000,
    sourceSequence: 1,
    sourceSubsequence: 0,
  });

const textDelta = (text: string, messageId?: string): AgentEvent =>
  event("text_delta", {
    agentType: "flowix",
    threadId: "t1",
    runId: "r1",
    timestamp: 2000,
    text,
    messageId: messageId ?? "assistant-r1",
    messagePhase: "updated",
    contentMode: "delta",
    sourceTimestamp: 2000,
    sourceSequence: 2,
    sourceSubsequence: 0,
  });

const reasoningDelta = (text: string): AgentEvent =>
  event("reasoning_delta", {
    agentType: "flowix",
    threadId: "t1",
    runId: "r1",
    timestamp: 3000,
    text,
    messageId: "reasoning-r1-block-0",
    messagePhase: "updated",
    contentMode: "delta",
    sourceTimestamp: 3000,
    sourceSequence: 3,
    sourceSubsequence: 0,
  });

const streamStart = (runId: string): AgentEvent =>
  event("stream_start", {
    agentType: "flowix",
    threadId: "t1",
    runId,
    timestamp: 0,
    model: "gpt-test",
  });

const streamEnd = (runId: string, reason: string | null = null): AgentEvent =>
  event("stream_end", {
    agentType: "flowix",
    threadId: "t1",
    runId,
    timestamp: 9000,
    reason,
  });

const errorEvent = (message: string): AgentEvent =>
  event("error", {
    agentType: "flowix",
    threadId: "t1",
    runId: "r1",
    timestamp: 9500,
    message,
  });

const toolCall = (id: string, name: string): AgentEvent =>
  event("tool_call", {
    agentType: "flowix",
    threadId: "t1",
    runId: "r1",
    timestamp: 4000,
    toolCallId: id,
    name,
    input: { command: "ls" },
    messageId: `tool-${id}`,
    messagePhase: "started",
    sourceTimestamp: 4000,
    sourceSequence: 4,
    sourceSubsequence: 0,
  });

const toolResult = (id: string, name: string): AgentEvent =>
  event("tool_result", {
    agentType: "flowix",
    threadId: "t1",
    runId: "r1",
    timestamp: 5000,
    toolCallId: id,
    name,
    result: { content: "ok" },
    messageId: `tool-${id}`,
    messagePhase: "completed",
    sourceTimestamp: 5000,
    sourceSequence: 5,
    sourceSubsequence: 0,
  });

describe("reduceProjection / emptyProjection", () => {
  it("emptyProjection returns a clean baseline", () => {
    expect(emptyProjection()).toMatchObject({
      messages: [],
      pending: { assistantId: null, reasoningId: null },
      pagination: {
        oldestSequence: null,
        hasMoreHistory: false,
        loadingInitial: false,
        loadingMore: false,
      },
      runs: {
        isLoading: false,
        activeRunId: null,
        runs: {},
      },
    });
  });

  it("reducer is pure (input not mutated)", () => {
    const p0 = emptyProjection();
    const p1 = reduceProjection(p0, userMessage("hi", "u1"));
    expect(p0.messages).toHaveLength(0);
    expect(p1.messages).toHaveLength(1);
    expect(p1).not.toBe(p0);
  });
});

describe("reduceProjection / text streaming lifecycle", () => {
  it("stream_start → text_delta → text_delta appends content", () => {
    let p = emptyProjection();
    p = reduceProjection(p, streamStart("r1"));
    expect(p.runs.isLoading).toBe(true);
    expect(p.runs.activeRunId).toBe("r1");
    expect(p.runs.runs["r1"]?.status).toBe("running");

    p = reduceProjection(p, textDelta("Hello "));
    expect(p.messages).toHaveLength(1);
    expect(p.messages[0]).toMatchObject({ role: "assistant", content: "Hello " });
    expect(p.pending.assistantId).toBe("assistant-r1");

    p = reduceProjection(p, textDelta("world"));
    expect(p.messages[0].content).toBe("Hello world");
    expect(p.messages).toHaveLength(1);
  });

  it("reasoning_delta before text_delta closes reasoning when text lands", () => {
    let p = emptyProjection();
    p = reduceProjection(p, streamStart("r1"));
    p = reduceProjection(p, reasoningDelta("think... "));
    expect(p.messages[0]).toMatchObject({ role: "reasoning", isCompleted: false });
    expect(p.pending.reasoningId).toBe("reasoning-r1-block-0");

    p = reduceProjection(p, textDelta("answer"));
    // applyTextChunk 关闭上一条 reasoning 行 (isCompleted=true) 然后追加 assistant.
    const reasoning = p.messages.find((m) => m.role === "reasoning");
    const assistant = p.messages.find((m) => m.role === "assistant");
    expect(reasoning).toMatchObject({ isCompleted: true });
    expect(assistant).toMatchObject({ content: "answer" });
    expect(p.pending.reasoningId).toBeNull();
    expect(p.pending.assistantId).toBe("assistant-r1");
  });

  it("stream_end completes the reasoning row and clears pending", () => {
    let p = emptyProjection();
    p = reduceProjection(p, streamStart("r1"));
    p = reduceProjection(p, reasoningDelta("only thinking"));
    p = reduceProjection(p, streamEnd("r1"));

    expect(p.messages).toHaveLength(1);
    expect(p.messages[0]).toMatchObject({
      role: "reasoning",
      content: "only thinking",
      isCompleted: true,
    });
    expect(p.runs.isLoading).toBe(false);
    expect(p.runs.activeRunId).toBeNull();
    expect(p.runs.lastRun?.status).toBe("completed");
    expect(p.pending.assistantId).toBeNull();
    expect(p.pending.reasoningId).toBeNull();
  });

  it("error chunk closes pending and inserts error assistant row", () => {
    let p = emptyProjection();
    p = reduceProjection(p, streamStart("r1"));
    p = reduceProjection(p, reasoningDelta("thinking"));
    p = reduceProjection(p, errorEvent("boom"));

    const reasoning = p.messages.find((m) => m.role === "reasoning");
    expect(reasoning?.isCompleted).toBe(true);
    const assistant = p.messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("boom");
    expect(p.runs.lastRun?.status).toBe("failed");
    expect(p.runs.isLoading).toBe(false);
  });
});

describe("reduceProjection / tool call cycle", () => {
  it("tool_call then tool_result completes the tool row without losing prior assistant", () => {
    let p = emptyProjection();
    p = reduceProjection(p, streamStart("r1"));
    p = reduceProjection(p, textDelta("calling tool"));
    p = reduceProjection(p, toolCall("c1", "Bash"));
    expect(p.messages.some((m) => m.role === "tool" && m.toolCallId === "c1")).toBe(true);
    expect(p.runs.runs["r1"]?.currentTool).toBe("Bash");
    expect(p.pending.assistantId).toBeNull();

    p = reduceProjection(p, toolResult("c1", "Bash"));
    const toolRow = p.messages.find((m) => m.role === "tool" && m.toolCallId === "c1");
    expect(toolRow?.isLoading).toBe(false);
    expect(p.runs.runs["r1"]?.currentTool).toBeNull();
  });

  it("stream_end closes any still-loading tool rows", () => {
    let p = emptyProjection();
    p = reduceProjection(p, streamStart("r1"));
    p = reduceProjection(p, toolCall("c1", "Bash"));
    expect(
      p.messages.find((m) => m.role === "tool" && m.toolCallId === "c1")?.isLoading,
    ).toBe(true);

    p = reduceProjection(p, streamEnd("r1"));
    expect(
      p.messages.find((m) => m.role === "tool" && m.toolCallId === "c1")?.isLoading,
    ).toBe(false);
  });
});

describe("reduceProjection / session_resolved is a no-op", () => {
  it("does not change projection state (handled by applyExternalSessionResolved cross-thread)", () => {
    let p = emptyProjection();
    p = reduceProjection(p, streamStart("r1"));
    p = reduceProjection(p, textDelta("hello"));
    const before = p;
    const after = reduceProjection(
      p,
      event("session_resolved", {
        agentType: "flowix",
        threadId: "t1",
        runId: "test-run",
        timestamp: 9999,
        sessionId: "session-xyz",
      }),
    );
    expect(after).toBe(before);
  });
});

describe("reduceProjection / usage accumulates into runs", () => {
  it("usage event updates runs[runId].usage", () => {
    let p = emptyProjection();
    p = reduceProjection(p, streamStart("r1"));
    p = reduceProjection(
      p,
      event("usage", {
        agentType: "flowix",
        threadId: "t1",
        runId: "r1",
        timestamp: 8000,
        usage: { input_tokens: 10, output_tokens: 20 },
        modelId: "gpt-test",
        lastRunAt: 8000,
      }),
    );
    expect(p.runs.runs["r1"]?.usage).toMatchObject({
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 0,
    });
  });
});