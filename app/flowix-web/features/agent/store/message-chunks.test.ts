import { describe, expect, it } from "vitest";

import { applyTextChunk } from "@features/agent/store/message-chunks";
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
});
