import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  initializeMemoLibrary: vi.fn(),
  restorePersistedMemoSession: vi.fn(),
  restoreAgentConversationWorkspace: vi.fn(),
  calls: [] as string[],
}));

vi.mock('@features/memo/use-cases/initialize-memo-library', () => ({
  initializeMemoLibrary: mocks.initializeMemoLibrary,
}));
vi.mock('@features/memo/use-cases/open-memo-session', () => ({
  restorePersistedMemoSession: mocks.restorePersistedMemoSession,
}));
vi.mock('@features/workspace/use-cases/agent-conversation-navigation', () => ({
  restoreAgentConversationWorkspace: mocks.restoreAgentConversationWorkspace,
}));

import { initializeMainWindowStartup } from './main-window-startup';

describe('initializeMainWindowStartup', () => {
  beforeEach(() => {
    mocks.calls.length = 0;
    mocks.initializeMemoLibrary.mockReset().mockImplementation(async () => {
      mocks.calls.push('memo-library');
    });
    mocks.restorePersistedMemoSession.mockReset().mockImplementation(async () => {
      mocks.calls.push('memo-session');
    });
    mocks.restoreAgentConversationWorkspace.mockReset().mockImplementation(async () => {
      mocks.calls.push('agent-workspace');
    });
  });

  it('runs startup stages in dependency order', async () => {
    await initializeMainWindowStartup();

    expect(mocks.calls).toEqual([
      'memo-library',
      'memo-session',
      'agent-workspace',
    ]);
  });

  it('stops dependent restoration when library initialization fails', async () => {
    mocks.initializeMemoLibrary.mockRejectedValueOnce(new Error('backend unavailable'));

    await expect(initializeMainWindowStartup()).rejects.toThrow('backend unavailable');
    expect(mocks.restorePersistedMemoSession).not.toHaveBeenCalled();
    expect(mocks.restoreAgentConversationWorkspace).not.toHaveBeenCalled();
  });
});
