import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@/types";
import {
  isOlderHistorySnapshot,
  reconcileHistorySnapshot,
} from "@features/agent/store/history-sync";

function message(id: string, role: ChatMessage["role"], content: string): ChatMessage {
  return {
    id,
    role,
    content,
    timestamp: "2026-08-29T00:00:00.000Z",
  };
}

describe("reconcileHistorySnapshot", () => {
  it("rejects only an older comparable sequence revision", () => {
    expect(isOlderHistorySnapshot(12, 11)).toBe(true);
    expect(isOlderHistorySnapshot(12, 12)).toBe(false);
    expect(isOlderHistorySnapshot(12, 13)).toBe(false);
    expect(isOlderHistorySnapshot(12, null)).toBe(false);
  });

  it("preserves the complete message array when an open snapshot renders identically", () => {
    const current = [message("u1", "user", "hello"), message("a1", "assistant", "hi")];
    const result = reconcileHistorySnapshot({
      agentType: "codex",
      current,
      snapshot: {
        messages: current.map((item) => ({ ...item })),
        revision: "sequence:1",
        oldestCursor: null,
        hasMore: false,
      },
      reason: "open",
    });

    expect(result.renderChanged).toBe(false);
    expect(result.messages).toBe(current);
  });

  it("adds a genuinely missing persisted row without replacing unaffected rows", () => {
    const user = message("u1", "user", "hello");
    const current = [user];
    const result = reconcileHistorySnapshot({
      agentType: "codex",
      current,
      snapshot: {
        messages: [
          { ...user },
          message("a1", "assistant", "persisted answer"),
        ],
        revision: "sequence:1",
        oldestCursor: null,
        hasMore: false,
      },
      reason: "recovery",
    });

    expect(result.renderChanged).toBe(true);
    expect(result.messages[0]).toBe(user);
    expect(result.messages.map((item) => item.id)).toEqual(["u1", "a1"]);
  });
});
