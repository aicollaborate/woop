import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/types";
import { completedRunUserMessageId } from "@features/agent/events/message-identity";
import { liveTurnMessages } from "@features/agent/store/codex-live-turn-cache";

const message = (id: string, role: ChatMessage["role"], content: string): ChatMessage => ({
  id,
  role,
  content,
  timestamp: new Date().toISOString(),
});

describe("codex live turn cache", () => {
  it("keeps only the current run from its optimistic user anchor", () => {
    const runId = "run-2";
    const messages = [
      message("old-user", "user", "old"),
      message("old-assistant", "assistant", "answer"),
      message(completedRunUserMessageId("codex", runId), "user", "next"),
      message("assistant-live", "assistant", "partial"),
    ];

    expect(liveTurnMessages(messages, runId).map((item) => item.id)).toEqual([
      completedRunUserMessageId("codex", runId),
      "assistant-live",
    ]);
  });

  it("does not cache an unrelated historical tail before the user anchor exists", () => {
    expect(liveTurnMessages([message("old", "assistant", "old")], "missing")).toEqual([]);
  });

  it("anchors on the provider user row once the optimistic id has been adopted", () => {
    const runId = "run-3";
    const messages = [
      message("old-user", "user", "old"),
      {
        ...message("item-u3", "user", "ask"),
        codexTurnId: "turn-3",
      },
      message("assistant-live", "assistant", "partial"),
    ];
    expect(
      liveTurnMessages(messages, runId, "turn-3").map((item) => item.id),
    ).toEqual(["item-u3", "assistant-live"]);
  });
});
