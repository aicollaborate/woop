import { describe, expect, it } from "vitest";

import {
  applyToolCallChunk,
  applyToolResultChunk,
} from "@features/agent/store/tool-chunks";
import {
  applyReasoningChunk,
  applyTextChunk,
  applyUserMessageChunk,
} from "@features/agent/store/message-chunks";
import type { LiveMessageState } from "@features/agent/store/chunk-result";

function emptyState(): LiveMessageState {
  return {
    messages: [],
    pendingAssistantId: null,
    pendingReasoningId: null,
  };
}

describe("tool chunk idempotency", () => {
  it("reconciles a persisted user message with the optimistic row by id", () => {
    const optimistic: LiveMessageState = {
      ...emptyState(),
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "question",
          timestamp: new Date(456).toISOString(),
        },
      ],
    };

    const reconciled = applyUserMessageChunk(optimistic, "question", {
      id: "user-1",
      sourceTimestamp: 456,
      sourceSequence: 0,
      sourceSubsequence: 0,
    });

    expect(reconciled.messages).toHaveLength(1);
    expect(reconciled.messages[0]).toMatchObject({
      id: "user-1",
      role: "user",
      content: "question",
      sourceTimestamp: 456,
      sourceSequence: 0,
    });
  });

  it("upserts repeated tool calls before applying the result", () => {
    const first = applyToolCallChunk(
      emptyState(),
      "future-1",
      "future_connector",
      { query: "first" },
      "codex",
    );
    const replayed = applyToolCallChunk(
      first,
      "future-1",
      "future_connector",
      { query: "complete" },
      "codex",
    );
    const completed = applyToolResultChunk(
      replayed,
      "future-1",
      "future_connector",
      { status: "completed" },
    );

    expect(completed.messages).toHaveLength(1);
    expect(completed.messages[0]).toMatchObject({
      role: "tool",
      toolCallId: "future-1",
      toolName: "future_connector",
      toolInput: { query: "complete" },
      isLoading: false,
    });
  });

  it("does not reopen an already completed tool row", () => {
    const started = applyToolCallChunk(
      emptyState(),
      "future-2",
      "future_connector",
      {},
      "codex",
    );
    const completed = applyToolResultChunk(
      started,
      "future-2",
      "future_connector",
      { status: "completed" },
    );
    const replayed = applyToolCallChunk(
      completed,
      "future-2",
      "future_connector",
      {},
      "codex",
    );

    expect(replayed.messages).toHaveLength(1);
    expect(replayed.messages[0].isLoading).toBe(false);
  });

  it("creates a visible fallback row when the tool call event was lost", () => {
    const completed = applyToolResultChunk(
      emptyState(),
      "future-result-only",
      "future_connector",
      { content: "fallback output" },
      "codex",
    );

    expect(completed.messages).toHaveLength(1);
    expect(completed.messages[0]).toMatchObject({
      role: "tool",
      toolCallId: "future-result-only",
      toolName: "future_connector",
      toolAgentType: "codex",
      content: "fallback output",
      isLoading: false,
    });
  });

  it("inserts a reconciled tool before a later assistant by source time", () => {
    const assistant = applyTextChunk(emptyState(), "final answer", {
      id: "assistant-item-2",
      phase: "completed",
      contentMode: "snapshot",
      sourceTimestamp: 2_000,
      sourceSequence: 20,
    });
    const tool = applyToolCallChunk(
      assistant,
      "call-1",
      "exec_command",
      { cmd: "pwd" },
      "codex",
      undefined,
      {
        id: "tool-call-1",
        phase: "started",
        sourceTimestamp: 1_000,
        sourceSequence: 10,
      },
    );

    expect(tool.messages.map((message) => message.id)).toEqual([
      "tool-call-1",
      "assistant-item-2",
    ]);
  });

  it("replaces repeated assistant snapshots with the same Codex message id", () => {
    const updated = applyTextChunk(
      applyTextChunk(emptyState(), "draft", {
        id: "assistant-item-3",
        phase: "updated",
        contentMode: "snapshot",
        sourceTimestamp: 1_000,
        sourceSequence: 10,
      }),
      "complete",
      {
        id: "assistant-item-3",
        phase: "completed",
        contentMode: "snapshot",
        sourceTimestamp: 1_100,
        sourceSequence: 11,
      },
    );

    expect(updated.messages).toHaveLength(1);
    expect(updated.messages[0]).toMatchObject({
      id: "assistant-item-3",
      content: "complete",
    });
    expect(updated.pendingAssistantId).toBeNull();
  });

  it("upserts reasoning snapshots by Codex message id and keeps the first order anchor", () => {
    const updated = applyReasoningChunk(
      applyReasoningChunk(emptyState(), "thinking", {
        id: "reasoning-item-1",
        phase: "updated",
        contentMode: "snapshot",
        sourceTimestamp: 1_000,
        sourceSequence: 4,
      }),
      "done thinking",
      {
        id: "reasoning-item-1",
        phase: "completed",
        contentMode: "snapshot",
        sourceTimestamp: 2_000,
        sourceSequence: 8,
      },
    );

    expect(updated.messages).toHaveLength(1);
    expect(updated.messages[0]).toMatchObject({
      id: "reasoning-item-1",
      content: "done thinking",
      sourceTimestamp: 1_000,
      sourceSequence: 4,
      isCompleted: true,
    });
    expect(updated.pendingReasoningId).toBeNull();
  });

  it("reopens and appends one run-scoped Claude reasoning row after a tool cycle", () => {
    const first = applyReasoningChunk(emptyState(), "first thought", {
      id: "reasoning-run-1",
      phase: "updated",
      contentMode: "delta",
      sourceTimestamp: 1_000,
      sourceSequence: 1,
    });
    const closed = applyTextChunk(first, "tool preface", {
      id: "assistant-message-1",
      phase: "completed",
      contentMode: "snapshot",
      sourceTimestamp: 1_100,
      sourceSequence: 2,
    });
    const continued = applyReasoningChunk(closed, "; second thought", {
      id: "reasoning-run-1",
      phase: "updated",
      contentMode: "delta",
      sourceTimestamp: 1_200,
      sourceSequence: 3,
    });

    expect(
      continued.messages.filter((message) => message.role === "reasoning"),
    ).toMatchObject([
      {
        id: "reasoning-run-1",
        content: "first thought; second thought",
        sourceTimestamp: 1_000,
        sourceSequence: 1,
        isCompleted: false,
      },
    ]);
    expect(continued.pendingReasoningId).toBe("reasoning-run-1");
  });
});
