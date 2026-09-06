import { describe, expect, it } from "vitest";

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

describe("assistant message chunks", () => {
  it("preserves the Codex turn id when the first chunk has a message id", () => {
    const result = applyTextChunk(emptyState(), "answer", {
      id: "assistant-item-1",
      phase: "completed",
      contentMode: "snapshot",
      codexTurnId: "turn-1",
    });

    expect(result.messages[0]).toMatchObject({
      id: "assistant-item-1",
      role: "assistant",
      codexTurnId: "turn-1",
    });
  });

  it("keeps every reference intact when a completed snapshot repeats streamed content", () => {
    const streamed = applyTextChunk(emptyState(), "final", {
      id: "assistant-item-1",
      codexTurnId: "turn-1",
    });
    const duplicate = applyTextChunk(streamed, "final", {
      id: "assistant-item-1",
      phase: "completed",
      contentMode: "snapshot",
      codexTurnId: "turn-1",
    });

    expect(duplicate.messages).toBe(streamed.messages);
    expect(duplicate.pendingAssistantId).toBeNull();
  });

  it("keeps every reference intact when a completed reasoning snapshot repeats itself", () => {
    const streamed = applyReasoningChunk(emptyState(), "plan", {
      id: "reasoning-item-1",
      phase: "completed",
      codexTurnId: "turn-1",
    });
    const duplicate = applyReasoningChunk(streamed, "plan", {
      id: "reasoning-item-1",
      phase: "completed",
      contentMode: "snapshot",
      codexTurnId: "turn-1",
    });

    expect(duplicate.messages).toBe(streamed.messages);
    expect(duplicate.pendingReasoningId).toBeNull();
  });
});

describe("user message chunks", () => {
  const optimisticRow = {
    id: "user-run-1",
    role: "user" as const,
    content: "ask",
    timestamp: "2026-01-01T00:00:01.000Z",
  };

  it("adopts the provider item id in place instead of appending a second row", () => {
    const state: LiveMessageState = {
      messages: [optimisticRow],
      pendingAssistantId: null,
      pendingReasoningId: null,
    };
    const result = applyUserMessageChunk(state, "ask", {
      id: "item-u1",
      phase: "completed",
      contentMode: "snapshot",
      codexTurnId: "turn-1",
      optimisticId: "user-run-1",
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      id: "item-u1",
      role: "user",
      codexTurnId: "turn-1",
      content: "ask",
    });
  });

  it("appends when no optimistic row exists for the run", () => {
    const result = applyUserMessageChunk(emptyState(), "ask", {
      id: "item-u1",
      phase: "completed",
      contentMode: "snapshot",
      codexTurnId: "turn-1",
      optimisticId: "user-run-1",
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].id).toBe("item-u1");
  });

  it("adopts by the newest matching optimistic row when run ids race", () => {
    const state: LiveMessageState = {
      messages: [
        { ...optimisticRow, id: "user-run-older", content: "same" },
        { ...optimisticRow, id: "user-run-current", content: "ask" },
      ],
      pendingAssistantId: null,
      pendingReasoningId: null,
    };
    const result = applyUserMessageChunk(state, "ask", {
      id: "item-u-current",
      codexTurnId: "turn-current",
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toMatchObject({
      id: "item-u-current",
      content: "ask",
      codexTurnId: "turn-current",
    });
  });

  it("never adopts without the provider turn id", () => {
    const state: LiveMessageState = {
      messages: [optimisticRow],
      pendingAssistantId: null,
      pendingReasoningId: null,
    };
    const result = applyUserMessageChunk(state, "ask again", {
      id: "user-run-1",
      phase: "completed",
      contentMode: "snapshot",
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      id: "user-run-1",
      content: "ask again",
    });
  });

  it("keeps DSH goal notices out of the human user bubble", () => {
    const state: LiveMessageState = {
      messages: [optimisticRow],
      pendingAssistantId: null,
      pendingReasoningId: null,
    };
    const result = applyUserMessageChunk(state, "目标执行中：在吗（第 1/256 轮）", {
      id: "goal-round-1",
      messageType: "goal-round",
      codexTurnId: "turn-1",
      optimisticId: "user-run-1",
      phase: "completed",
      contentMode: "snapshot",
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toBe(optimisticRow);
    expect(result.messages[1]).toMatchObject({
      id: "goal-round-1",
      role: "system",
      messageType: "goal-round",
      content: "目标执行中：在吗（第 1/256 轮）",
    });
  });
});
