import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/types";
import type { AgentRunState } from "@/types/agent";
import {
  emptyProjection,
  mergeThreadProjections,
} from "@features/agent/store/session-reducer";

const assistantMsg = (id: string, content: string): ChatMessage => ({
  id,
  role: "assistant",
  content,
  timestamp: "2026-08-03T00:00:00.000Z",
});

const run = (runId: string, status: AgentRunState["status"] = "running"): AgentRunState => ({
  runId,
  agentType: "flowix",
  threadId: "tid",
  startedAt: 1,
  status,
});

describe("mergeThreadProjections", () => {
  it("returns to projection when from is undefined", () => {
    const to = emptyProjection();
    to.messages = [assistantMsg("a1", "hi")];
    to.runs.isLoading = true;
    to.runs.activeRunId = "r1";
    to.runs.runs.r1 = run("r1");

    const merged = mergeThreadProjections(undefined, to, "flowix");

    expect(merged.messages).toEqual(to.messages);
    expect(merged.runs.activeRunId).toBe("r1");
    expect(merged.runs.isLoading).toBe(true);
  });

  it("returns from projection when to is undefined", () => {
    const from = emptyProjection();
    from.messages = [assistantMsg("a1", "hi")];
    from.runs.activeRunId = "r-from";

    const merged = mergeThreadProjections(from, undefined, "flowix");

    expect(merged.messages).toEqual(from.messages);
    expect(merged.runs.activeRunId).toBe("r-from");
  });

  it("prefers to.messages and merges from.messages (with dedup) when both exist", () => {
    const from = emptyProjection();
    from.messages = [
      assistantMsg("a1", "early-from"),
      assistantMsg("a2", "shared"), // duplicate id `a2`
    ];
    const to = emptyProjection();
    to.messages = [assistantMsg("a2", "shared"), assistantMsg("a3", "later-to")];

    const merged = mergeThreadProjections(from, to, "flowix");

    // mergeHistoricalMessages 走 stable key 去重. to 在前, from 在后:
    // - "a2" (shared) 出现两次, 应只剩一条 (to 优先).
    // - "a3" 来自 to, "a1" 来自 from, 都保留.
    const ids = merged.messages.map((m) => m.id);
    expect(ids.filter((id) => id === "a2")).toHaveLength(1);
    expect(ids).toContain("a1");
    expect(ids).toContain("a3");
  });

  it("uses to.pending.* ids first, falling back to from", () => {
    const from = emptyProjection();
    from.pending.assistantId = "from-assistant";
    const to = emptyProjection();
    to.pending.reasoningId = "to-reasoning";

    const merged = mergeThreadProjections(from, to, "flowix");

    // to.assistantId is null → from fills in
    expect(merged.pending.assistantId).toBe("from-assistant");
    // to.reasoningId is set → wins
    expect(merged.pending.reasoningId).toBe("to-reasoning");
  });

  it("OR-s merges isLoading and hasMoreHistory", () => {
    const from = emptyProjection();
    from.runs.isLoading = true;
    from.pagination.hasMoreHistory = false;
    const to = emptyProjection();
    to.runs.isLoading = false;
    to.pagination.hasMoreHistory = true;

    const merged = mergeThreadProjections(from, to, "flowix");

    expect(merged.runs.isLoading).toBe(true);
    expect(merged.pagination.hasMoreHistory).toBe(true);
  });

  it("first-non-null wins for oldestSequence and activeRunId", () => {
    const from = emptyProjection();
    from.pagination.oldestSequence = 10;
    from.runs.activeRunId = "r-from";
    const to = emptyProjection();
    // to's oldestSequence is null → from fills in
    // to's activeRunId is null → from fills in
    const merged = mergeThreadProjections(from, to, "flowix");

    expect(merged.pagination.oldestSequence).toBe(10);
    expect(merged.runs.activeRunId).toBe("r-from");
  });

  it("first-non-null wins when to is the source", () => {
    const from = emptyProjection();
    from.pagination.oldestSequence = 10;
    from.runs.activeRunId = "r-from";
    const to = emptyProjection();
    to.pagination.oldestSequence = 5;
    to.runs.activeRunId = "r-to";

    const merged = mergeThreadProjections(from, to, "flowix");

    // to 的非 null 值优先
    expect(merged.pagination.oldestSequence).toBe(5);
    expect(merged.runs.activeRunId).toBe("r-to");
  });

  it("merges runs records from both projections", () => {
    const from = emptyProjection();
    from.runs.runs.r1 = run("r1", "completed");
    const to = emptyProjection();
    to.runs.runs.r2 = run("r2", "running");
    to.runs.runs.r3 = run("r3");

    const merged = mergeThreadProjections(from, to, "flowix");

    expect(Object.keys(merged.runs.runs).sort()).toEqual(["r1", "r2", "r3"]);
    expect(merged.runs.runs.r1?.status).toBe("completed");
    expect(merged.runs.runs.r2?.status).toBe("running");
  });

  it("uses to.lastRun first, falling back to from", () => {
    const fromLast = { runId: "r-from", agentType: "flowix" as const, status: "completed" as const, startedAt: 1, endedAt: 2 };
    const toLast = { runId: "r-to", agentType: "flowix" as const, status: "completed" as const, startedAt: 3, endedAt: 4 };
    const from = emptyProjection();
    from.runs.lastRun = fromLast;
    const to = emptyProjection();
    to.runs.lastRun = toLast;

    const merged = mergeThreadProjections(from, to, "flowix");

    expect(merged.runs.lastRun?.runId).toBe("r-to");
  });

  it("uses to.loading state as canonical", () => {
    const from = emptyProjection();
    from.pagination.loadingInitial = false;
    from.pagination.loadingMore = true;
    const to = emptyProjection();
    to.pagination.loadingInitial = true;
    to.pagination.loadingMore = false;

    const merged = mergeThreadProjections(from, to, "flowix");

    // loading 状态以 to (canonical session) 为准, 不用 from 覆盖
    expect(merged.pagination.loadingInitial).toBe(true);
    expect(merged.pagination.loadingMore).toBe(false);
  });
});