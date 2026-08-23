import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/types";
import {
  getAgentMessageEndTimeText,
  getAgentMessageVisibleContent,
} from "@features/agent/message/agent-message";

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
  it("does not throw when a persisted message has an invalid timestamp", () => {
    expect(
      getAgentMessageEndTimeText(errorMessage({ timestamp: "invalid" }), "zh-CN"),
    ).toBe("");
  });

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

  it("keeps only the Harness error message and hides stderr/stack details", () => {
    expect(
      getAgentMessageVisibleContent(
        errorMessage({
          content: [
            "[HARNESS_RUN_FAILED] JSON-RPC input closed",
            "exit code: 1",
            "stderr tail:",
            "Error: dsh-jsonrpc-agent: plugin tree failed to load",
            "    at /local/path/app-boot/src/index.ts:800:11",
          ].join("\n"),
        }),
        "zh-CN",
      ),
    ).toBe("DeepSeek Harness 重连失败\n\n失败原因：JSON-RPC input closed");
  });

  it("shows the upstream provider message before diagnostic metadata", () => {
    expect(
      getAgentMessageVisibleContent(
        errorMessage({
          id: "msg:claude:run-1:error:error",
          content: "Claude Code CLI exited with status exit status: 1",
          errorDetails: {
            category: "rate_limited",
            statusCode: 429,
            requestId: "req-1",
            exitCode: 1,
            upstreamMessage: "5 hour usage limit reached",
            retryable: false,
          },
        }),
        "zh-CN",
      ),
    ).toBe(
      "5 hour usage limit reached\n\n请求受到限流，请等待配额恢复后重试。\n\nHTTP 429 · 请求 ID：req-1 · CLI 退出状态：1",
    );

    expect(
      getAgentMessageVisibleContent(
        errorMessage({
          id: "msg:claude:run-1:error:error-en",
          content: "rate limited",
          errorDetails: {
            category: "rate_limited",
            statusCode: 429,
            retryAfter: "60s",
            requestId: "req-1",
            retryable: true,
          },
        }),
        "en-US",
      ),
    ).toBe(
      "rate limited\n\nThe request was rate limited. Retry after the quota recovers.\n\nHTTP 429 · Request ID: req-1 · Retry after: 60s",
    );
  });

  it("removes the legacy Claude/Codex process wrapper when details are absent", () => {
    expect(
      getAgentMessageVisibleContent(
        errorMessage({
          id: "assistant-2",
          content:
            "Claude Code CLI exited with status exit status: 1: 5 hour usage limit reached",
        }),
        "zh-CN",
      ),
    ).toBe("5 hour usage limit reached");
  });
});
