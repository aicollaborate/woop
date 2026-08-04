import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@/types/agent";
import {
  createStreamEventDispatcher,
  type StreamEventDispatcherPorts,
} from "@features/agent/store/stream-event-dispatcher";
import {
  emptyProjection,
  reduceProjection,
  type ThreadProjection,
} from "@features/agent/store/session-reducer";

function createPorts() {
  const projections: Record<string, ThreadProjection> = {};
  const resolved: Record<string, string> = {};
  const tombstones = new Set<string>();
  const applySessionResolved = vi.fn(
    (event: AgentEvent & { kind: "session_resolved" }) => {
      resolved[event.threadId] = event.sessionId;
    },
  );
  const ports: StreamEventDispatcherPorts = {
    getProjection: (threadId) => projections[threadId],
    getThreadAgentType: () => "codex",
    resolveThreadId: (threadId) => resolved[threadId] ?? threadId,
    canDispatch: (threadId) => !tombstones.has(threadId),
    dispatch: (event) => {
      projections[event.threadId] = reduceProjection(
        projections[event.threadId] ?? emptyProjection(),
        event,
      );
    },
    applySessionResolved,
  };
  return { ports, projections, resolved, tombstones, applySessionResolved };
}

describe("createStreamEventDispatcher", () => {
  it("buffers text through an injected scheduler without importing Zustand", () => {
    const { ports, projections } = createPorts();
    let scheduled: FrameRequestCallback | null = null;
    const dispatcher = createStreamEventDispatcher(ports, {
      request: (callback) => {
        scheduled = callback;
        return 1;
      },
      cancel: vi.fn(),
    });
    dispatcher.dispatch({
      kind: "stream_start",
      agentType: "codex",
      threadId: "thread-1",
      runId: "run-1",
      timestamp: 1,
    });
    dispatcher.dispatch({
      kind: "text_delta",
      agentType: "codex",
      threadId: "thread-1",
      runId: "run-1",
      timestamp: 2,
      text: "buffered answer",
      contentMode: "delta",
      messagePhase: "updated",
      sourceTimestamp: 2,
    });

    expect(projections["thread-1"].messages).toEqual([]);
    expect(scheduled).not.toBeNull();
    (scheduled as unknown as FrameRequestCallback)(3);

    expect(projections["thread-1"].messages[0]?.content).toBe(
      "buffered answer",
    );
  });

  it("routes session resolution through the injected atomic action", () => {
    const { ports, applySessionResolved } = createPorts();
    const dispatcher = createStreamEventDispatcher(ports);
    const event: AgentEvent & { kind: "session_resolved" } = {
      kind: "session_resolved",
      agentType: "codex",
      threadId: "local-thread",
      sessionId: "session-thread",
      runId: "run-1",
      timestamp: 1,
    };

    dispatcher.dispatch(event);

    expect(applySessionResolved).toHaveBeenCalledOnce();
    expect(applySessionResolved).toHaveBeenCalledWith(event);
  });

  it("drops events for tombstoned threads", () => {
    const { ports, projections, tombstones } = createPorts();
    tombstones.add("deleted-thread");
    const dispatcher = createStreamEventDispatcher(ports);

    dispatcher.dispatch({
      kind: "stream_start",
      agentType: "codex",
      threadId: "deleted-thread",
      runId: "late-run",
      timestamp: 1,
    });

    expect(projections["deleted-thread"]).toBeUndefined();
  });
});
