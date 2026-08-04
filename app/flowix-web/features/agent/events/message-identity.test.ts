import { describe, expect, it } from "vitest";
import {
  canonicalAgentMessageId,
  completedRunUserMessageId,
} from "@features/agent/events/message-identity";

describe("canonical agent message identity", () => {
  it.each(["codex", "claude", "hermes", "opencode"] as const)(
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

  it("is idempotent and preserves Flowix compatibility", () => {
    const canonical = "msg:codex:run-1:assistant:source-1";
    expect(
      canonicalAgentMessageId("codex", "run-1", "assistant", canonical),
    ).toBe(canonical);
    expect(completedRunUserMessageId("flowix", "run-1")).toBe("user-run-1");
  });
});
