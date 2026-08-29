import { describe, expect, it } from "vitest";
import {
  canonicalAgentMessageId,
  completedRunUserMessageId,
} from "@features/agent/events/message-identity";

describe("canonical agent message identity", () => {
  it.each(["claude", "hermes", "opencode", "deepseek-harness"] as const)(
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

  it("keeps Codex provider item ids unwrapped across live and history", () => {
    // App-server item ids are identical in live notifications and
    // thread/turns/list history; wrapping them would fork the identity
    // space of one row (verified against real rollouts: no cross-turn
    // collisions). Errors stay run-scoped.
    expect(
      canonicalAgentMessageId("codex", "run-1", "assistant", "source-1"),
    ).toBe("source-1");
    expect(
      canonicalAgentMessageId("codex", "run-1", "tool-call", "call-1"),
    ).toBe("call-1");
    expect(
      canonicalAgentMessageId("codex", "run-1", "user", "user-run-1"),
    ).toBe("user-run-1");
    expect(canonicalAgentMessageId("codex", "run-1", "error", "error")).toBe(
      "msg:codex:run-1:error:error",
    );
    expect(completedRunUserMessageId("codex", "run-1")).toBe("user-run-1");
  });

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
