import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@/types";
import {
  areMessagesEquivalent,
  filterRenderableHistoryMessages,
  mergeLiveMessagesIntoRenderableMessages,
  mergeMessagesForThreadRender,
  replaceCompletedRunWithHistory,
} from "@features/agent/store/thread-history";

function message(
  id: string,
  role: ChatMessage["role"],
  content: string,
  timestamp: string,
): ChatMessage {
  return {
    id,
    role,
    content,
    timestamp,
  };
}

describe("mergeMessagesForThreadRender", () => {
  it("removes the system context from historical user messages", () => {
    expect(filterRenderableHistoryMessages([
      message(
        "u1",
        "user",
        "question\n<## CONTEXT PROMPT ##>\nhidden context",
        "2026-01-01T00:00:00.000Z",
      ),
    ])).toEqual([
      message("u1", "user", "question", "2026-01-01T00:00:00.000Z"),
    ]);
  });

  it("removes the Flowix workspace context from historical user messages", () => {
    expect(filterRenderableHistoryMessages([
      message(
        "u2",
        "user",
        "你好\n\n[Flowix workspace context]\ninternal workspace details",
        "2026-01-01T00:00:00.000Z",
      ),
    ])).toEqual([
      message("u2", "user", "你好", "2026-01-01T00:00:00.000Z"),
    ]);
  });

  it("keeps a later live user message with the same visible content", () => {
    const history = [
      message("history-user-1", "user", "same", "2026-01-01T00:00:00.000Z"),
      message("history-assistant-1", "assistant", "done", "2026-01-01T00:00:01.000Z"),
    ];
    const live = [
      message("live-user-2", "user", "same", "2026-01-01T00:00:02.000Z"),
    ];

    expect(mergeMessagesForThreadRender(history, live).map((m) => m.id)).toEqual([
      "history-user-1",
      "history-assistant-1",
      "live-user-2",
    ]);
  });

  it("orders a live user before a later historical assistant reply", () => {
    const history = [
      message("history-assistant-1", "assistant", "reply", "2026-01-01T00:00:02.000Z"),
    ];
    const live = [
      message("live-user-1", "user", "ask", "2026-01-01T00:00:01.000Z"),
    ];

    expect(mergeMessagesForThreadRender(history, live).map((m) => m.id)).toEqual([
      "live-user-1",
      "history-assistant-1",
    ]);
  });
});

describe("mergeLiveMessagesIntoRenderableMessages", () => {
  it("updates an existing live message by id inside the render list", () => {
    const existing = [
      message("assistant-live", "assistant", "Hel", "2026-01-01T00:00:01.000Z"),
    ];
    const live = [
      message("assistant-live", "assistant", "Hello", "2026-01-01T00:00:01.000Z"),
    ];

    expect(
      mergeLiveMessagesIntoRenderableMessages(existing, live)[0],
    ).toMatchObject({
      id: "assistant-live",
      content: "Hello",
    });
  });
});

describe("replaceCompletedRunWithHistory", () => {
  it("treats separately allocated but identical history messages as equivalent", () => {
    const existing = [
      message("m1", "assistant", "done", "2026-01-01T00:00:01.000Z"),
    ];
    const history = [
      message("m1", "assistant", "done", "2026-01-01T00:00:01.000Z"),
    ];

    expect(areMessagesEquivalent(existing, history)).toBe(true);
  });

  it("replaces a partial live run while preserving older loaded messages", () => {
    const existing = [
      message("older-user", "user", "old", "2026-01-01T00:00:00.000Z"),
      message("user-run-1", "user", "ask", "2026-01-01T00:00:01.000Z"),
      message("assistant-live", "assistant", "part", "2026-01-01T00:00:02.000Z"),
    ];
    const history = [
      message("user-run-1", "user", "ask", "2026-01-01T00:00:01.000Z"),
      message("assistant-final", "assistant", "complete", "2026-01-01T00:00:03.000Z"),
    ];

    expect(
      replaceCompletedRunWithHistory(existing, history, "run-1").map((m) => m.id),
    ).toEqual(["older-user", "user-run-1", "assistant-final"]);
  });

  it("keeps live references when Codex history only changes persistence metadata", () => {
    const user = message(
      "msg:codex:run-1:user:user-run-1",
      "user",
      "ask",
      "2026-01-01T00:00:01.000Z",
    );
    const assistant = message(
      "msg:codex:run-1:assistant:item-1",
      "assistant",
      "complete",
      "2026-01-01T00:00:02.000Z",
    );
    const existing = [user, assistant];
    const history = [
      message(user.id, "user", "ask", "2026-01-01T00:00:10.000Z"),
      message(assistant.id, "assistant", "complete", "2026-01-01T00:00:11.000Z"),
    ];

    const reconciled = replaceCompletedRunWithHistory(
      existing,
      history,
      "run-1",
      "codex",
    );

    expect(reconciled).toBe(existing);
    expect(reconciled[0]).toBe(user);
    expect(reconciled[1]).toBe(assistant);
  });

  it("keeps a live tool in place when the completion snapshot is missing it", () => {
    const existing = [
      message("older-user", "user", "old", "2026-01-01T00:00:00.000Z"),
      message(
        "msg:codex:run-1:user:user-run-1",
        "user",
        "ask",
        "2026-01-01T00:00:01.000Z",
      ),
      {
        ...message("live-tool", "tool", "tool output", "2026-01-01T00:00:02.000Z"),
        toolCallId: "msg:codex:run-1:tool-call:call-1",
        toolName: "command_execution",
      },
      message("assistant-live", "assistant", "part", "2026-01-01T00:00:03.000Z"),
    ];
    const history = [
      message(
        "msg:codex:run-1:user:user-run-1",
        "user",
        "ask",
        "2026-01-01T00:00:01.000Z",
      ),
      message("assistant-final", "assistant", "complete", "2026-01-01T00:00:03.000Z"),
    ];

    expect(
      replaceCompletedRunWithHistory(existing, history, "run-1", "codex").map(
        (m) => m.id,
      ),
    ).toEqual([
      "older-user",
      "msg:codex:run-1:user:user-run-1",
      "live-tool",
      "assistant-final",
    ]);
  });
});

describe("message dedup keys (content fingerprint)", () => {
  // Exercise the dedup contract through the public merge API: same content
  // must suppress; different content (even by a single trailing char) must not.
  // These guard the JSON.stringify → contentFingerprint replacement.

  it("suppresses a history assistant reply duplicated by a live one with identical content", () => {
    const history = [
      message("h-1", "assistant", "answer", "2026-01-01T00:00:00.000Z"),
    ];
    const live = [
      message("l-1", "assistant", "answer", "2026-01-01T00:00:00.000Z"),
    ];
    expect(mergeMessagesForThreadRender(history, live).map((m) => m.id)).toEqual([
      "h-1",
    ]);
  });

  it("keeps both messages when content differs by one trailing char", () => {
    const history = [
      message("h-1", "assistant", "answer", "2026-01-01T00:00:00.000Z"),
    ];
    const live = [
      message("l-1", "assistant", "answer!", "2026-01-01T00:00:00.000Z"),
    ];
    expect(mergeMessagesForThreadRender(history, live).map((m) => m.id)).toEqual([
      "h-1",
      "l-1",
    ]);
  });

  it("keeps both messages when role differs but content matches", () => {
    const history = [
      message("h-1", "assistant", "x", "2026-01-01T00:00:00.000Z"),
    ];
    const live = [
      message("l-1", "reasoning", "x", "2026-01-01T00:00:00.000Z"),
    ];
    expect(mergeMessagesForThreadRender(history, live).map((m) => m.id)).toEqual([
      "h-1",
      "l-1",
    ]);
  });

  it("dedupes multi-MB content without timing out (smoke test for fingerprint)", () => {
    const big = "x".repeat(2_000_000);
    const history = [
      message("h-1", "assistant", big, "2026-01-01T00:00:00.000Z"),
    ];
    const live = [
      message("l-1", "assistant", big, "2026-01-01T00:00:00.000Z"),
    ];
    const t0 = Date.now();
    const merged = mergeMessagesForThreadRender(history, live);
    const elapsed = Date.now() - t0;
    expect(merged.map((m) => m.id)).toEqual(["h-1"]);
    // JSON.stringify over 2MB repeated content would dominate this budget.
    // Fingerprint should stay comfortably under 200ms even on slow CI.
    expect(elapsed).toBeLessThan(2000);
  });
});
