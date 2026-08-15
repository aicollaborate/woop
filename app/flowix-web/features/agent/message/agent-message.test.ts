import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/types";
import { getAgentMessageVisibleContent } from "@features/agent/message/agent-message";

function errorMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "msg:deepseek-harness:r1:error:error",
    role: "assistant",
    content: "Request timed out.",
    timestamp: "2026-08-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("DeepSeek Harness reconnect error display", () => {
  it("shows a localized reconnect message and the original failure reason", () => {
    expect(getAgentMessageVisibleContent(errorMessage(), "zh-CN")).toBe(
      "DeepSeek Harness 重连失败\n\n失败原因：Request timed out.",
    );
    expect(getAgentMessageVisibleContent(errorMessage(), "en-US")).toBe(
      "DeepSeek Harness reconnect failed\n\nFailure reason: Request timed out.",
    );
  });

  it("does not change ordinary assistant errors", () => {
    expect(
      getAgentMessageVisibleContent(
        errorMessage({
          id: "assistant-1",
          content: "Request timed out.",
          notice: undefined,
        }),
        "zh-CN",
      ),
    ).toBe("Request timed out.");
  });
});
