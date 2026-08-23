import { describe, expect, it } from "vitest";
import {
  canonicalAgentMessageId,
  completedRunUserMessageId,
} from "@features/agent/events/message-identity";

describe("canonical agent message identity", () => {
  it.each(["codex", "claude", "hermes", "opencode", "deepseek-harness"] as const)(
    "uses the shared rule for %s",
    (agentType) => {
      expect(
        canonicalAgentMessageId(
          agentType,
          "run-1",
          "assistant",
          "source-1",
        ),
      ).toBe(`msg:${agentType}:run-1:assistant:source-1`);
    },
  );

  it("is idempotent and preserves the canonical user-message identity", () => {
    const canonical = "msg:codex:run-1:assistant:source-1";
    expect(
      canonicalAgentMessageId("codex", "run-1", "assistant", canonical),
    ).toBe(canonical);
    expect(completedRunUserMessageId("deepseek-harness", "run-1")).toBe(
      "msg:deepseek-harness:run-1:user:user-run-1",
    );
  });
});
