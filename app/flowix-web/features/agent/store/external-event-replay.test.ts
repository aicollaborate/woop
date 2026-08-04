import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionStore } from "@features/agent/store/agent-session-store";
import type { ExternalReplayPorts } from "@features/agent/store/external-event-replay";

const externalEventsMock = vi.hoisted(() => vi.fn());

vi.mock("@platform/tauri/client", () => ({
  agent: {
    externalEvents: externalEventsMock,
    chatStream: vi.fn(),
    stopChatStream: vi.fn(async () => true),
    runningThreads: vi.fn(async () => ({})),
    listThreads: vi.fn(async () => []),
    listCodexThreads: vi.fn(async () => []),
    listClaudeThreads: vi.fn(async () => []),
    listHermesThreads: vi.fn(async () => []),
    listLocalAgentThreads: vi.fn(async () => []),
    createThread: vi.fn(),
    getThread: vi.fn(async () => ({ messages: [] })),
    getThreadPage: vi.fn(async () => ({
      messages: [],
      oldestSequence: null,
      hasMore: false,
    })),
    getCodexThread: vi.fn(async () => ({ messages: [] })),
    getCodexThreadPage: vi.fn(async () => ({
      messages: [],
      oldestSequence: null,
      hasMore: false,
    })),
    getClaudeThread: vi.fn(async () => ({ messages: [] })),
    getClaudeThreadPage: vi.fn(async () => ({
      messages: [],
      oldestSequence: null,
      hasMore: false,
    })),
    getHermesThread: vi.fn(async () => ({ messages: [] })),
    getHermesThreadPage: vi.fn(async () => ({
      messages: [],
      oldestSequence: null,
      hasMore: false,
    })),
    deleteThread: vi.fn(),
    updateThreadTitle: vi.fn(),
    listConversationInstances: vi.fn(async () => []),
    getConversationInstance: vi.fn(async () => null),
    findConversationByThread: vi.fn(async () => null),
    upsertConversationInstance: vi.fn(async () => undefined),
    deleteConversationInstance: vi.fn(async () => undefined),
    deleteConversationInstancesForThread: vi.fn(async () => undefined),
  },
  listenToAgentStream: vi.fn(),
}));

vi.mock("@features/memo/store/memo-store", () => ({
  useMemoStore: {
    getState: () => ({
      selectedNotebook: null,
      selectedMemo: null,
      notebooks: [],
    }),
  },
}));

vi.mock("@features/document", () => ({
  getActiveDocumentDraft: () => null,
  useDocumentStore: {
    getState: () => ({
      currentDocumentPath: "",
    }),
  },
}));

vi.mock("@features/agent/store/agent-access-store", () => ({
  useAgentAccessStore: {
    getState: () => ({
      config: { entries: [] },
    }),
  },
}));

vi.mock("@features/preferences/store/user-settings-store", () => ({
  useUserSettingsStore: {
    getState: () => ({
      settings: { language: "zh-CN" },
    }),
  },
}));

function event(
  id: number,
  threadId: string,
  payload: unknown,
  runtime = "codex",
) {
  return {
    id,
    runtime,
    threadId,
    normalizedJson: JSON.stringify(payload),
    rawJson: null,
    createdAt: 1_000 + id,
  };
}

function replayPorts(store: {
  getState(): AgentSessionStore;
}): ExternalReplayPorts {
  return {
    canCommit: () => true,
    resetThreads: (threadIds, typeKey) => {
      store.getState().resetThreadProjections(threadIds);
      store.getState().setSessionMeta((meta) => {
        const threadTypes = { ...meta.threadTypes };
        for (const threadId of threadIds) threadTypes[threadId] ??= typeKey;
        return { ...meta, threadTypes };
      });
    },
    dispatchChunk: (chunk) => store.getState().dispatchAgentChunk(chunk),
    flush: () => store.getState().flushAgentEventBuffer(),
  };
}

describe("external event replay", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    const { DEFAULT_AGENT_SESSION_META, useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    useAgentSessionStore.setState({
      sessionMeta: DEFAULT_AGENT_SESSION_META,
      conversationRegistry: { instances: {} },
      threadProjections: {},
      threadEpochs: {},
      threadTombstones: {},
    });
  });

  it("rebuilds messages and terminal run state from persisted payload events", async () => {
    const { replayExternalEventsForThread } = await import(
      "@features/agent/store/external-event-replay"
    );
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    const threadId = "codex-replay-thread";
    const runId = "codex-replay-run";

    externalEventsMock.mockResolvedValueOnce([
      event(1, threadId, {
        kind: "user_message",
        thread_id: threadId,
        run_id: runId,
        agent_type: "codex",
        id: "user-replay-1",
        text: "Persisted question",
        timestamp: 900,
      }),
      event(2, threadId, {
        kind: "stream_start",
        thread_id: threadId,
        run_id: runId,
        agent_type: "codex",
        model: "gpt-5",
      }),
      event(3, threadId, {
        kind: "text",
        thread_id: threadId,
        run_id: runId,
        agent_type: "codex",
        text: "Persisted answer",
      }),
      event(4, threadId, {
        kind: "usage",
        thread_id: threadId,
        run_id: runId,
        agent_type: "codex",
        usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
      }),
      event(5, threadId, {
        kind: "stream_end",
        thread_id: threadId,
        run_id: runId,
        agent_type: "codex",
        reason: null,
      }),
    ]);

    const replayedDisplay = await replayExternalEventsForThread(
      "codex",
      threadId,
      replayPorts(useAgentSessionStore),
    );

    expect(replayedDisplay.status).toBe("replayed");
    expect(externalEventsMock).toHaveBeenCalledWith(threadId, null, 1000);

    const projection = useAgentSessionStore.getState().threadProjections[threadId];
    expect(projection.runs.isLoading).toBe(false);
    expect(projection.runs.activeRunId).toBeNull();
    expect(projection.runs.runs[runId]).toBeUndefined();
    expect(projection.runs.lastRun).toMatchObject({
      runId,
      status: "completed",
      usage: { total_tokens: 7 },
      model: "gpt-5",
    });

    const messages = projection.messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      id: "msg:codex:codex-replay-run:user:user-replay-1",
      role: "user",
      content: "Persisted question",
    });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "Persisted answer",
    });
  });

  it("keeps repeated Codex item ids isolated across runs", async () => {
    const { replayExternalEventsForThread } = await import(
      "@features/agent/store/external-event-replay"
    );
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    const threadId = "codex-reused-item-ids";
    const firstRunId = "run-first";
    const secondRunId = "run-second";
    const runEvents = (
      firstEventId: number,
      runId: string,
      question: string,
      answer: string,
      toolResult: string,
      sourceTimestamp: number,
    ) => [
      event(firstEventId, threadId, {
        kind: "user_message",
        thread_id: threadId,
        run_id: runId,
        agent_type: "codex",
        id: `user-${runId}`,
        text: question,
        timestamp: sourceTimestamp,
      }),
      event(firstEventId + 1, threadId, {
        kind: "stream_start",
        thread_id: threadId,
        run_id: runId,
        agent_type: "codex",
      }),
      event(firstEventId + 2, threadId, {
        kind: "text",
        thread_id: threadId,
        run_id: runId,
        agent_type: "codex",
        message_id: "assistant-item_0",
        message_phase: "completed",
        content_mode: "snapshot",
        source_timestamp: sourceTimestamp + 1,
        source_sequence: 1,
        source_subsequence: 0,
        text: answer,
      }),
      event(firstEventId + 3, threadId, {
        kind: "tool_call",
        thread_id: threadId,
        run_id: runId,
        agent_type: "codex",
        id: "tool-item_1",
        name: "command_execution",
        input: { command: "pwd" },
        message_id: "tool-tool-item_1",
        source_timestamp: sourceTimestamp + 2,
        source_sequence: 2,
        source_subsequence: 0,
      }),
      event(firstEventId + 4, threadId, {
        kind: "tool_result",
        thread_id: threadId,
        run_id: runId,
        agent_type: "codex",
        id: "tool-item_1",
        name: "command_execution",
        result: toolResult,
        message_id: "tool-tool-item_1",
        source_timestamp: sourceTimestamp + 3,
        source_sequence: 3,
        source_subsequence: 0,
      }),
      event(firstEventId + 5, threadId, {
        kind: "stream_end",
        thread_id: threadId,
        run_id: runId,
        agent_type: "codex",
        reason: null,
      }),
    ];

    externalEventsMock.mockResolvedValueOnce([
      ...runEvents(1, firstRunId, "question 1", "answer 1", "result 1", 1_000),
      ...runEvents(7, secondRunId, "question 2", "answer 2", "result 2", 2_000),
    ]);

    expect(
      await replayExternalEventsForThread(
        "codex",
        threadId,
        replayPorts(useAgentSessionStore),
      ),
    ).toMatchObject({ status: "replayed" });

    const messages =
      useAgentSessionStore.getState().threadProjections[threadId].messages;
    expect(messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "question 1" },
      { role: "assistant", content: "answer 1" },
      { role: "tool", content: '"result 1"' },
      { role: "user", content: "question 2" },
      { role: "assistant", content: "answer 2" },
      { role: "tool", content: '"result 2"' },
    ]);
    expect(messages[1].id).toBe(
      "msg:codex:run-first:assistant:assistant-item_0",
    );
    expect(messages[4].id).toBe(
      "msg:codex:run-second:assistant:assistant-item_0",
    );
    expect(messages[2].toolCallId).toBe(
      "msg:codex:run-first:tool-call:tool-item_1",
    );
    expect(messages[5].toolCallId).toBe(
      "msg:codex:run-second:tool-call:tool-item_1",
    );
  });

  it("folds legacy Claude reasoning ids into one row during database replay", async () => {
    const { replayExternalEventsForThread } = await import(
      "@features/agent/store/external-event-replay"
    );
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    const threadId = "claude-replay-reasoning-tool-cycle";
    const runId = "claude-replay-reasoning-run";

    externalEventsMock.mockResolvedValueOnce([
      event(
        1,
        threadId,
        {
          kind: "user_message",
          thread_id: threadId,
          run_id: runId,
          agent_type: "claude",
          id: "claude-replay-user",
          text: "inspect the project",
          timestamp: 900,
        },
        "claude",
      ),
      event(
        2,
        threadId,
        {
          kind: "stream_start",
          thread_id: threadId,
          run_id: runId,
          agent_type: "claude",
        },
        "claude",
      ),
      event(
        3,
        threadId,
        {
          kind: "reasoning",
          thread_id: threadId,
          run_id: runId,
          agent_type: "claude",
          text: "first persisted thought\n\n",
          message_id: "reasoning-old-provider-message-1-block-0",
          message_phase: "updated",
          content_mode: "delta",
          source_timestamp: 1_000,
          source_sequence: 1,
          source_subsequence: 0,
        },
        "claude",
      ),
      event(
        4,
        threadId,
        {
          kind: "tool_call",
          thread_id: threadId,
          run_id: runId,
          agent_type: "claude",
          id: "persisted-tool-1",
          name: "Bash",
          input: { command: "pwd" },
          message_id: "tool-persisted-tool-1",
          message_phase: "started",
          source_timestamp: 1_100,
          source_sequence: 2,
          source_subsequence: 0,
        },
        "claude",
      ),
      event(
        5,
        threadId,
        {
          kind: "tool_result",
          thread_id: threadId,
          run_id: runId,
          agent_type: "claude",
          id: "persisted-tool-1",
          name: "Bash",
          result: { content: "/workspace" },
          message_id: "tool-persisted-tool-1",
          message_phase: "completed",
          source_timestamp: 1_200,
          source_sequence: 3,
          source_subsequence: 0,
        },
        "claude",
      ),
      event(
        6,
        threadId,
        {
          kind: "reasoning",
          thread_id: threadId,
          run_id: runId,
          agent_type: "claude",
          text: "second persisted thought",
          message_id: "reasoning-old-provider-message-2-block-0",
          message_phase: "updated",
          content_mode: "delta",
          source_timestamp: 1_300,
          source_sequence: 4,
          source_subsequence: 0,
        },
        "claude",
      ),
      event(
        7,
        threadId,
        {
          kind: "text",
          thread_id: threadId,
          run_id: runId,
          agent_type: "claude",
          text: "persisted final answer",
          message_id: "assistant-old-provider-message-2-block-1",
          message_phase: "updated",
          content_mode: "delta",
          source_timestamp: 1_400,
          source_sequence: 5,
          source_subsequence: 0,
        },
        "claude",
      ),
      event(
        8,
        threadId,
        {
          kind: "stream_end",
          thread_id: threadId,
          run_id: runId,
          agent_type: "claude",
          reason: null,
        },
        "claude",
      ),
    ]);

    const replayedDatabase = await replayExternalEventsForThread(
      "claude",
      threadId,
      replayPorts(useAgentSessionStore),
    );

    expect(replayedDatabase.status).toBe("replayed");
    const projection = useAgentSessionStore.getState().threadProjections[threadId];
    const messages = projection.messages;
    const reasoning = messages.filter((message) => message.role === "reasoning");

    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]).toMatchObject({
      id: `msg:claude:${runId}:reasoning:reasoning-${runId}`,
      content: "first persisted thought\n\nsecond persisted thought",
      isCompleted: true,
    });
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "reasoning",
      "tool",
      "assistant",
    ]);
    expect(messages[2]).toMatchObject({
      toolCallId: `msg:claude:${runId}:tool-call:persisted-tool-1`,
      isLoading: false,
    });
    expect(projection.runs).toMatchObject({
      isLoading: false,
      activeRunId: null,
      lastRun: { runId, status: "completed" },
    });
  });

  it("folds legacy per-delta Claude assistant ids during database replay", async () => {
    const { replayExternalEventsForThread } = await import(
      "@features/agent/store/external-event-replay"
    );
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    const threadId = "claude-replay-envelope-text";
    const runId = "claude-replay-envelope-run";

    externalEventsMock.mockResolvedValueOnce([
      event(
        1,
        threadId,
        {
          kind: "user_message",
          thread_id: threadId,
          run_id: runId,
          agent_type: "claude",
          id: "claude-envelope-user",
          text: "question",
          timestamp: 900,
        },
        "claude",
      ),
      event(
        2,
        threadId,
        {
          kind: "stream_start",
          thread_id: threadId,
          run_id: runId,
          agent_type: "claude",
        },
        "claude",
      ),
      event(
        3,
        threadId,
        {
          kind: "text",
          thread_id: threadId,
          run_id: runId,
          agent_type: "claude",
          text: "我来帮你把 `/",
          message_id:
            "assistant-d9193ae4-86b5-47a6-9e85-1bb4ef0acc1c-block-1",
          message_phase: "updated",
          content_mode: "delta",
          source_timestamp: 1_000,
          source_sequence: 43,
          source_subsequence: 0,
        },
        "claude",
      ),
      event(
        4,
        threadId,
        {
          kind: "text",
          thread_id: threadId,
          run_id: runId,
          agent_type: "claude",
          text: "Users/rop/Desktop`",
          message_id:
            "assistant-63038373-bb9a-446d-a640-6ea503e68857-block-1",
          message_phase: "updated",
          content_mode: "delta",
          source_timestamp: 1_001,
          source_sequence: 44,
          source_subsequence: 0,
        },
        "claude",
      ),
      event(
        5,
        threadId,
        {
          kind: "stream_end",
          thread_id: threadId,
          run_id: runId,
          agent_type: "claude",
          reason: null,
        },
        "claude",
      ),
    ]);

    expect(
      await replayExternalEventsForThread(
        "claude",
        threadId,
        replayPorts(useAgentSessionStore),
      ),
    ).toMatchObject({ status: "replayed" });

    const messages =
      useAgentSessionStore.getState().threadProjections[threadId].messages;
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "我来帮你把 `/Users/rop/Desktop`",
      sourceSequence: 43,
    });
  });

  it("falls back without dispatching when database replay fails", async () => {
    const { replayExternalEventsForThread } = await import(
      "@features/agent/store/external-event-replay"
    );
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    const threadId = "claude-database-error";
    externalEventsMock.mockRejectedValueOnce(new Error("database unavailable"));

    const replayedDatabase = await replayExternalEventsForThread(
      "claude",
      threadId,
      replayPorts(useAgentSessionStore),
    );

    expect(replayedDatabase).toEqual({
      status: "fallback",
      reason: "read_failed",
    });
    expect(
      useAgentSessionStore.getState().threadProjections[threadId],
    ).toBeUndefined();
  });

  it("preserves an existing live projection when database replay falls back", async () => {
    const { replayExternalEventsForThread } = await import(
      "@features/agent/store/external-event-replay"
    );
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    const threadId = "claude-live-before-replay-error";
    useAgentSessionStore.getState().dispatch({
      kind: "stream_start",
      agentType: "claude",
      threadId,
      runId: "live-run",
      timestamp: 1,
    });
    const before = useAgentSessionStore.getState().threadProjections[threadId];
    externalEventsMock.mockRejectedValueOnce(new Error("database unavailable"));

    const result = await replayExternalEventsForThread(
      "claude",
      threadId,
      replayPorts(useAgentSessionStore),
    );

    expect(result).toEqual({ status: "fallback", reason: "read_failed" });
    expect(useAgentSessionStore.getState().threadProjections[threadId]).toBe(before);
  });

  it("does not reset or dispatch when a validated replay becomes stale", async () => {
    const { replayExternalEventsForThread } = await import(
      "@features/agent/store/external-event-replay"
    );
    const threadId = "codex-stale-replay";
    externalEventsMock.mockResolvedValueOnce([
      event(1, threadId, {
        kind: "user_message",
        thread_id: threadId,
        run_id: "stale-run",
        agent_type: "codex",
        text: "question",
      }),
    ]);
    const resetThreads = vi.fn();
    const dispatchChunk = vi.fn();
    const flush = vi.fn();

    const result = await replayExternalEventsForThread("codex", threadId, {
      canCommit: () => false,
      resetThreads,
      dispatchChunk,
      flush,
    });

    expect(result).toEqual({ status: "stale" });
    expect(resetThreads).not.toHaveBeenCalled();
    expect(dispatchChunk).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });

  it("rejects the entire database source when history is marked truncated", async () => {
    const { replayExternalEventsForThread } = await import(
      "@features/agent/store/external-event-replay"
    );
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    const threadId = "claude-truncated-thread";

    externalEventsMock.mockResolvedValueOnce([
      event(1, threadId, { kind: "history_truncated", version: 1 }),
      event(2, threadId, {
        kind: "text",
        thread_id: threadId,
        run_id: "claude-run",
        agent_type: "claude",
        text: "must not be partially replayed",
      }),
    ]);

    const replayedDatabase = await replayExternalEventsForThread(
      "claude",
      threadId,
      replayPorts(useAgentSessionStore),
    );

    expect(replayedDatabase).toEqual({
      status: "fallback",
      reason: "truncated",
    });
    expect(
      useAgentSessionStore.getState().threadProjections[threadId],
    ).toBeUndefined();
  });
});
