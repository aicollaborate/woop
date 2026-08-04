import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AGENT_SESSION_META,
  useAgentSessionStore,
} from "@features/agent/store/agent-session-store";
import { emptyProjection } from "@features/agent/store/session-reducer";
import { STORAGE_KEYS } from "@/lib/constants";
import { DEFAULT_AGENT_TYPE_KEY } from "@/lib/agent-types";

const streamStart = (runId: string, threadId = "t1") => ({
  kind: "stream_start" as const,
  agentType: "flowix" as const,
  threadId,
  runId,
  timestamp: 0,
  model: "gpt-test",
});

const textDelta = (text: string, runId: string, threadId = "t1") => ({
  kind: "text_delta" as const,
  agentType: "flowix" as const,
  threadId,
  runId,
  timestamp: 1000,
  text,
  messageId: "assistant-r1",
  messagePhase: "updated" as const,
  contentMode: "delta" as const,
  sourceTimestamp: 1000,
  sourceSequence: 1,
  sourceSubsequence: 0,
});

const streamEnd = (runId: string, threadId = "t1") => ({
  kind: "stream_end" as const,
  agentType: "flowix" as const,
  threadId,
  runId,
  timestamp: 2000,
  reason: null,
});

describe("useAgentSessionStore", () => {
  beforeEach(() => {
    useAgentSessionStore.setState({
      sessionMeta: DEFAULT_AGENT_SESSION_META,
      conversationRegistry: { instances: {} },
      threadProjections: {},
    });
  });

  it("starts with empty projections and default meta", () => {
    const s = useAgentSessionStore.getState();
    expect(s.threadProjections).toEqual({});
    expect(s.sessionMeta.activeAgentTypeKey).toBe("flowix");
    expect(s.conversationRegistry.instances).toEqual({});
  });

  it("dispatch(stream_start) creates a thread projection lazily", () => {
    useAgentSessionStore.getState().dispatch(streamStart("r1"));
    const proj = useAgentSessionStore.getState().threadProjections["t1"];
    expect(proj).toBeDefined();
    expect(proj?.runs.isLoading).toBe(true);
    expect(proj?.runs.activeRunId).toBe("r1");
    expect(proj?.messages).toEqual([]);
  });

  it("dispatch chain (stream_start → text_delta → stream_end) updates only one projection atomically", () => {
    const { dispatch } = useAgentSessionStore.getState();
    dispatch(streamStart("r1"));
    dispatch(textDelta("hello", "r1"));
    dispatch(streamEnd("r1"));

    const proj = useAgentSessionStore.getState().threadProjections["t1"];
    expect(proj?.runs.isLoading).toBe(false);
    expect(proj?.runs.lastRun?.status).toBe("completed");
    expect(proj?.messages).toHaveLength(1);
    expect(proj?.messages[0]).toMatchObject({
      role: "assistant",
      content: "hello",
    });
  });

  it("dispatch is no-op for unknown event kinds (no projection churn)", () => {
    const before = useAgentSessionStore.getState();
    before.dispatch({
      kind: "session_resolved",
      agentType: "flowix",
      threadId: "t1",
      runId: "test-run",
      timestamp: 0,
      sessionId: "session-xyz",
    });
    const after = useAgentSessionStore.getState();
    expect(after.threadProjections).toBe(before.threadProjections);
  });

  it("setSessionMeta updates metadata without touching projections", () => {
    useAgentSessionStore.getState().dispatch(streamStart("r1"));
    const projBefore = useAgentSessionStore.getState().threadProjections["t1"];

    useAgentSessionStore.getState().setSessionMeta((meta) => ({
      ...meta,
      activeAgentTypeKey: "codex",
    }));

    const s = useAgentSessionStore.getState();
    expect(s.sessionMeta.activeAgentTypeKey).toBe("codex");
    // Projections ref unchanged (no churn).
    expect(s.threadProjections["t1"]).toBe(projBefore);
  });

  it("removeThreadProjection drops a thread entry", () => {
    useAgentSessionStore.getState().dispatch(streamStart("r1"));
    expect(useAgentSessionStore.getState().threadProjections["t1"]).toBeDefined();
    useAgentSessionStore.getState().removeThreadProjection("t1");
    expect(useAgentSessionStore.getState().threadProjections["t1"]).toBeUndefined();
  });

  it("resetThreadProjections replaces specified entries with empty", () => {
    useAgentSessionStore.getState().dispatch(streamStart("r1", "t1"));
    useAgentSessionStore.getState().dispatch(streamStart("r2", "t2"));
    useAgentSessionStore.getState().resetThreadProjections(["t1"]);
    const s = useAgentSessionStore.getState();
    expect(s.threadProjections["t1"]).toEqual(emptyProjection());
    expect(s.threadProjections["t2"]?.runs.isLoading).toBe(true);
  });
});

describe("useAgentSessionStore persist", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.resetModules();
  });

  it("migrates legacy chat-store flat format from STORAGE_KEYS.CHAT", async () => {
    localStorage.setItem(
      STORAGE_KEYS.CHAT,
      JSON.stringify({
        state: {
          activeThreadIds: { codex: "codex-thread-1" },
          activeAgentTypeKey: "codex",
          threadTypes: { "codex-thread-1": "codex" },
          currentThreadTitles: { codex: "Codex Title" },
          agentPermissionMode: "read-only",
          agentCodexModel: "claude-opus-4-8",
          agentCodexReasoningEffort: "high",
          externalSessionResolutions: { "local-1": "real-1" },
        },
        version: 0,
      }),
    );

    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    const meta = useAgentSessionStore.getState().sessionMeta;

    expect(meta.activeAgentTypeKey).toBe("codex");
    expect(meta.activeThreadIds.codex).toBe("codex-thread-1");
    expect(meta.threadTypes["codex-thread-1"]).toBe("codex");
    expect(meta.currentThreadTitles.codex).toBe("Codex Title");
    expect(meta.settings.agentPermissionMode).toBe("read-only");
    expect(meta.settings.agentCodexModel).toBe("claude-opus-4-8");
    expect(meta.settings.agentCodexReasoningEffort).toBe("high");
    expect(meta.externalSessionResolutions["local-1"]).toBe("real-1");
    expect(localStorage.getItem(STORAGE_KEYS.CHAT)).toBeNull();
    // runtime-only 字段不从持久化恢复
    expect(meta.threadLists).toEqual({});
    expect(meta.lastRunningRunsReconciledAt).toBeNull();
  });

  it("persists sessionMeta (incl. settings) and rehydrates from AGENT_SESSION", async () => {
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    useAgentSessionStore.getState().setSessionMeta((m) => ({
      ...m,
      activeAgentTypeKey: "codex",
      activeThreadIds: { ...m.activeThreadIds, codex: "thread-x" },
      settings: { ...m.settings, agentCodexReasoningEffort: "high" },
    }));

    const stored = JSON.parse(
      localStorage.getItem(STORAGE_KEYS.AGENT_SESSION)!,
    );
    expect(stored.state.sessionMeta.activeAgentTypeKey).toBeUndefined();
    expect(stored.state.sessionMeta.settings.agentCodexReasoningEffort).toBe(
      "high",
    );
    const windowStored = JSON.parse(
      sessionStorage.getItem(`${STORAGE_KEYS.AGENT_SESSION}:window:main`)!,
    );
    expect(windowStored.state.sessionMeta.activeAgentTypeKey).toBe("codex");

    vi.resetModules();
    const { useAgentSessionStore: rehydrated } = await import(
      "@features/agent/store/agent-session-store"
    );
    const meta = rehydrated.getState().sessionMeta;
    expect(meta.activeAgentTypeKey).toBe("codex");
    expect(meta.activeThreadIds.codex).toBe("thread-x");
    expect(meta.settings.agentCodexReasoningEffort).toBe("high");
  });

  it("prefers AGENT_SESSION over legacy CHAT migration", async () => {
    localStorage.setItem(
      STORAGE_KEYS.CHAT,
      JSON.stringify({ state: { activeAgentTypeKey: "claude" } }),
    );
    localStorage.setItem(
      STORAGE_KEYS.AGENT_SESSION,
      JSON.stringify({
        state: {
          sessionMeta: {
            ...DEFAULT_AGENT_SESSION_META,
            activeAgentTypeKey: "codex",
          },
        },
        version: 0,
      }),
    );

    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    expect(
      useAgentSessionStore.getState().sessionMeta.activeAgentTypeKey,
    ).toBe("codex");
  });

  it("falls back to default activeAgentTypeKey when persisted value is unselectable", async () => {
    localStorage.setItem(
      STORAGE_KEYS.AGENT_SESSION,
      JSON.stringify({
        state: {
          sessionMeta: {
            ...DEFAULT_AGENT_SESSION_META,
            activeAgentTypeKey: "bogus-type",
          },
        },
        version: 0,
      }),
    );

    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    expect(
      useAgentSessionStore.getState().sessionMeta.activeAgentTypeKey,
    ).toBe(DEFAULT_AGENT_TYPE_KEY);
  });

  it("uses DEFAULT_SESSION_META when no persisted data exists", async () => {
    const { useAgentSessionStore } = await import(
      "@features/agent/store/agent-session-store"
    );
    expect(useAgentSessionStore.getState().sessionMeta).toEqual(
      DEFAULT_AGENT_SESSION_META,
    );
  });
});
