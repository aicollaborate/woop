import { beforeEach, describe, expect, it, vi } from "vitest";

const agentConversationStoreMock = vi.hoisted(() => ({
  loadMessages: vi.fn(
    async (_typeKey?: string, _threadId?: string) => undefined,
  ),
  messageStates: {},
}));
const replayExternalEventsMock = vi.hoisted(() =>
  vi.fn(
    async (_set: unknown, _get: unknown, _typeKey: string, _threadId: string) =>
      false,
  ),
);

vi.mock("@features/agent/store/agent-conversation-store", () => ({
  useAgentConversationStore: {
    getState: () => agentConversationStoreMock,
  },
}));

vi.mock("@features/agent/store/chat-store", () => ({
  useChatStore: {
    setState: vi.fn(),
    getState: vi.fn(() => ({})),
  },
}));

vi.mock("@features/agent/store/external-event-replay", () => ({
  replayExternalEventsForThread: replayExternalEventsMock,
}));

vi.mock("@features/agent/services/external-agent-runtime-service", () => ({
  isLocalExternalThreadId: vi.fn(
    (threadId: string, typeKey: string) =>
      threadId.startsWith(`${typeKey}-pending-`) ||
      threadId.startsWith(`${typeKey}-local-`),
  ),
  resolveExternalSessionId: vi.fn(async () => null),
}));

describe("agent thread card cache helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    replayExternalEventsMock.mockResolvedValue(false);
    agentConversationStoreMock.messageStates = {};
  });

  it("loads standard thread cache for non external agents", async () => {
    const { loadAgentThreadCardCache } =
      await import("./agent-thread-card-cache");

    const result = await loadAgentThreadCardCache({
      threadId: "flowix-thread",
      typeKey: "flowix",
    });

    expect(agentConversationStoreMock.loadMessages).toHaveBeenCalledWith(
      "flowix",
      "flowix-thread",
    );
    expect(result).toEqual({
      resolvedSessionId: null,
      loadedThreadId: "flowix-thread",
      messages: [],
    });
  });

  it("loads a resolved Codex session before replacing its local id", async () => {
    const { resolveExternalSessionId } =
      await import("@features/agent/services/external-agent-runtime-service");
    vi.mocked(resolveExternalSessionId).mockResolvedValueOnce(
      "codex-real-session",
    );
    const { loadAgentThreadCardCache } =
      await import("./agent-thread-card-cache");

    const result = await loadAgentThreadCardCache({
      threadId: "codex-local-inst-1",
      typeKey: "codex",
    });

    expect(result).toEqual({
      resolvedSessionId: "codex-real-session",
      loadedThreadId: "codex-real-session",
      messages: [],
    });
    expect(agentConversationStoreMock.loadMessages).toHaveBeenCalledWith(
      "codex",
      "codex-real-session",
    );
    expect(replayExternalEventsMock).not.toHaveBeenCalled();
  });

  it("loads Codex history for a resolved session id", async () => {
    const { loadAgentThreadCardCache } =
      await import("./agent-thread-card-cache");

    const result = await loadAgentThreadCardCache({
      threadId: "codex-real-session",
      typeKey: "codex",
    });

    expect(agentConversationStoreMock.loadMessages).toHaveBeenCalledWith(
      "codex",
      "codex-real-session",
    );
    expect(replayExternalEventsMock).not.toHaveBeenCalled();
    expect(result.loadedThreadId).toBe("codex-real-session");
  });

  it("loads Claude history for a resolved session id", async () => {
    const { loadAgentThreadCardCache } =
      await import("./agent-thread-card-cache");

    const result = await loadAgentThreadCardCache({
      threadId: "claude-real-session",
      typeKey: "claude",
    });

    expect(agentConversationStoreMock.loadMessages).toHaveBeenCalledWith(
      "claude",
      "claude-real-session",
    );
    expect(replayExternalEventsMock).not.toHaveBeenCalled();
    expect(result.loadedThreadId).toBe("claude-real-session");
  });

  it("loads OpenCode history from the paginated thread message store", async () => {
    const messages = [
      { id: "user-1", role: "user", content: "hello", timestamp: "1" },
      { id: "assistant-1", role: "assistant", content: "hi", timestamp: "2" },
    ];
    agentConversationStoreMock.loadMessages.mockImplementationOnce(
      async (typeKey, threadId) => {
        expect(typeKey).toBe("opencode");
        expect(threadId).toBe("opencode-session-1");
        agentConversationStoreMock.messageStates = {
          "opencode-session-1": { messages },
        };
      },
    );
    const { loadAgentThreadCardCache } =
      await import("./agent-thread-card-cache");

    const result = await loadAgentThreadCardCache({
      threadId: "opencode-session-1",
      typeKey: "opencode",
    });

    expect(replayExternalEventsMock).not.toHaveBeenCalled();
    expect(agentConversationStoreMock.loadMessages).toHaveBeenCalledWith(
      "opencode",
      "opencode-session-1",
    );
    expect(result.messages).toEqual(messages);
  });
});
