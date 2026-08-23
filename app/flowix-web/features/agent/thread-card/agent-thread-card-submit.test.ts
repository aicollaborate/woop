import { beforeEach, describe, expect, it, vi } from 'vitest';

const chatStoreMock = vi.hoisted(() => ({
  setActiveAgentThread: vi.fn(),
}));

const sessionStoreMock = vi.hoisted(() => ({
  setSessionMeta: vi.fn(),
  loadThreadList: vi.fn(async () => undefined),
}));

vi.mock('@features/agent/store/agent-session-test-facade', () => ({
  useChatStore: {
    getState: () => chatStoreMock,
  },
}));

vi.mock('@features/agent/store/agent-session-store', () => ({
  useAgentSessionStore: {
    getState: () => sessionStoreMock,
  },
}));

vi.mock('@features/agent/services/external-agent-runtime-service', () => ({
  beginExternalAgentThreadCardRun: vi.fn(() => 'codex-local-inst-1'),
}));

vi.mock('@platform/tauri/client', () => ({
  agent: {
    createThread: vi.fn(async (title: string) => ({
      threadId: 'flowix-thread-1',
      title,
      createdAt: 1,
      updatedAt: 1,
    })),
  },
}));

describe('agent thread card submit helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates an instance-backed local runtime thread for external agents', async () => {
    const { beginExternalAgentThreadCardRun } = await import('@features/agent/services/external-agent-runtime-service');
    const { ensureAgentThreadCardThread } = await import('./agent-thread-card-submit');

    const result = await ensureAgentThreadCardThread({
      prompt: 'hello codex',
      fallbackTitle: 'AI',
      typeKey: 'codex',
      currentThreadId: null,
      runtimeHandleId: 'handle-1',
      instanceId: 'inst-1',
      buildTitle: (prompt) => `Title: ${prompt}`,
    });

    expect(result).toEqual({
      threadId: 'codex-local-inst-1',
      title: 'Title: hello codex',
      typeKey: 'codex',
    });
    expect(beginExternalAgentThreadCardRun).toHaveBeenCalledWith(
      'handle-1',
      'codex',
      null,
      'inst-1',
    );
    expect(chatStoreMock.setActiveAgentThread).not.toHaveBeenCalled();
  });

  it('starts a DeepSeek Harness thread through the external runtime bridge', async () => {
    const { agent } = await import('@platform/tauri/client');
    const { beginExternalAgentThreadCardRun } = await import(
      '@features/agent/services/external-agent-runtime-service',
    );
    const { ensureAgentThreadCardThread } = await import('./agent-thread-card-submit');

    const result = await ensureAgentThreadCardThread({
      prompt: 'hello flowix',
      fallbackTitle: 'AI',
      typeKey: 'deepseek-harness',
      currentThreadId: null,
      runtimeHandleId: 'handle-1',
      instanceId: 'inst-1',
      buildTitle: (prompt) => `Title: ${prompt}`,
    });

    expect(agent.createThread).not.toHaveBeenCalled();
    expect(beginExternalAgentThreadCardRun).toHaveBeenCalledWith(
      'handle-1',
      'deepseek-harness',
      null,
      'inst-1',
    );
    expect(sessionStoreMock.setSessionMeta).not.toHaveBeenCalled();
    expect(sessionStoreMock.loadThreadList).not.toHaveBeenCalled();
    expect(result).toEqual({
      threadId: 'codex-local-inst-1',
      title: 'Title: hello flowix',
      typeKey: 'deepseek-harness',
    });
  });
});
