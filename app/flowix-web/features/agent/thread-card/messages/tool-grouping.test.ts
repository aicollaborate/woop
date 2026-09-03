import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/types";
import {
  areAgentRenderItemsEqual,
  groupAgentMessages,
} from "@features/agent/thread-card/messages/tool-grouping";

function message(
  id: string,
  role: ChatMessage["role"],
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role,
    content: role === "tool" ? "result" : id,
    timestamp: "2026-09-03T00:00:00.000Z",
    ...overrides,
  };
}

describe("groupAgentMessages", () => {
  it("groups only adjacent tools and keeps non-tool rows as boundaries", () => {
    const items = groupAgentMessages([
      message("a1", "assistant"),
      message("t1", "tool"),
      message("t2", "tool"),
      message("a2", "assistant"),
      message("t3", "tool"),
    ]);

    expect(items.map((item) => item.kind)).toEqual([
      "message",
      "tool-group",
      "message",
      "tool-group",
    ]);
    const group = items[1];
    expect(group.kind).toBe("tool-group");
    if (group.kind === "tool-group") {
      expect(group.tools.map((tool) => tool.id)).toEqual(["t1", "t2"]);
      expect(group.totalCount).toBe(2);
      expect(group.status).toBe("completed");
    }
  });

  it("keeps a singleton tool in a tool-group container", () => {
    const [item] = groupAgentMessages([message("t1", "tool")]);
    expect(item.kind).toBe("tool-group");
    if (item.kind === "tool-group") {
      expect(item.tools).toHaveLength(1);
      expect(item.totalCount).toBe(1);
    }
  });

  it("includes the running tool in the group and exposes a preview batch", () => {
    const running = message("t2", "tool", { isLoading: true, content: "" });
    const [item] = groupAgentMessages(
      [message("t1", "tool"), running],
      new Map([["tool-group:t1", [running]]]),
    );

    expect(item.kind).toBe("tool-group");
    if (item.kind === "tool-group") {
      expect(item.status).toBe("running");
      expect(item.totalCount).toBe(2);
      expect(item.previewTools).toEqual([running]);
    }
  });

  it("moves the final tool from running to completed after its result arrives", () => {
    const [item] = groupAgentMessages([
      message("t1", "tool"),
      message("t2", "tool", { content: "done", isLoading: false }),
    ]);
    expect(item.kind).toBe("tool-group");
    if (item.kind === "tool-group") {
      expect(item.status).toBe("completed");
      expect(item.previewTools).toBeUndefined();
    }
  });

  it("does not call an orphaned or failed tool completed", () => {
    const [orphaned] = groupAgentMessages([
      message("t1", "tool", { content: "ok" }),
      message("t2", "tool", { content: "", isLoading: false }),
    ]);
    const [failed] = groupAgentMessages([
      message("t1", "tool", { content: "ok" }),
      message("t2", "tool", { content: "[error] cancelled", isLoading: false }),
    ]);

    expect(orphaned.kind === "tool-group" && orphaned.status).toBe("failed");
    expect(failed.kind === "tool-group" && failed.status).toBe("failed");
  });

  it("compares groups by their message references and state", () => {
    const first = groupAgentMessages([message("t1", "tool"), message("t2", "tool")])[0];
    const same = groupAgentMessages([message("t1", "tool"), message("t2", "tool")])[0];
    expect(areAgentRenderItemsEqual(first, same)).toBe(false);
    expect(areAgentRenderItemsEqual(first, first)).toBe(true);
  });
});
