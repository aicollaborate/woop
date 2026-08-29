import { describe, expect, it, vi } from "vitest";
import { createRuntimeInfoRequester } from "./runtime-info-requester";

const mocks = vi.hoisted(() => ({
  getCodexSessionId: vi.fn(),
  getCodexRuntimeInfo: vi.fn(),
  getOpenCodeSessionId: vi.fn(),
  sessionUsage: vi.fn(),
}));

vi.mock("@platform/tauri/client", () => ({
  agent: {
    getCodexSessionId: mocks.getCodexSessionId,
    getCodexRuntimeInfo: mocks.getCodexRuntimeInfo,
    getOpenCodeSessionId: mocks.getOpenCodeSessionId,
  },
  deepseekHarness: { sessionUsage: mocks.sessionUsage },
}));

describe("createRuntimeInfoRequester", () => {
  it("returns undefined for agent types without a runtime provider", () => {
    expect(createRuntimeInfoRequester("claude", () => "thread-1")).toBeUndefined();
  });

  it("resolves null without invoking when the thread id is missing", async () => {
    for (const typeKey of ["deepseek-harness", "opencode", "codex"] as const) {
      const request = createRuntimeInfoRequester(typeKey, () => null);
      await expect(request?.()).resolves.toBeNull();
    }
    expect(mocks.sessionUsage).not.toHaveBeenCalled();
    expect(mocks.getOpenCodeSessionId).not.toHaveBeenCalled();
    expect(mocks.getCodexSessionId).not.toHaveBeenCalled();
  });

  it("reads the thread id at call time instead of creation time", async () => {
    let threadId: string | null = null;
    const request = createRuntimeInfoRequester("deepseek-harness", () => threadId);
    await expect(request?.()).resolves.toBeNull();
    threadId = "thread-2";
    mocks.sessionUsage.mockResolvedValue({
      sessionId: "dsh-session-2",
      model: "deepseek-chat",
      usage: { input_tokens: 12 },
    });
    await expect(request?.()).resolves.toEqual({
      sessionId: "dsh-session-2",
      model: "deepseek-chat",
      usage: { input_tokens: 12 },
    });
    expect(mocks.sessionUsage).toHaveBeenCalledWith("thread-2");
  });

  it("maps codex session id and runtime info into the card payload", async () => {
    mocks.getCodexSessionId.mockResolvedValue("sess-1");
    const info = { account: { planType: "plus" }, usage: { input_tokens: 1 } };
    mocks.getCodexRuntimeInfo.mockResolvedValue(info);
    const request = createRuntimeInfoRequester("codex", () => "thread-1");
    await expect(request?.()).resolves.toEqual({
      sessionId: "sess-1",
      usage: { input_tokens: 1 },
      codex: info,
    });
    expect(mocks.getCodexSessionId).toHaveBeenCalledWith("thread-1");
    expect(mocks.getCodexRuntimeInfo).toHaveBeenCalledWith("sess-1");
  });
});
