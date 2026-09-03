import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openAgentConversation: vi.fn().mockResolvedValue(undefined),
  beginNavigation: vi.fn().mockReturnValue(1),
  commitNavigation: vi.fn().mockReturnValue(true),
  failNavigation: vi.fn().mockReturnValue(true),
  isCurrentNavigation: vi.fn().mockReturnValue(true),
  activeAgentConversationId: 'conversation-a',
  selectAgentConversation: vi.fn(),
  setActivePluginId: vi.fn(),
  setSelectedMemo: vi.fn(),
}));

vi.mock('@features/agent/store/agent-session-store', () => ({
  useAgentSessionStore: { getState: vi.fn() },
}));

vi.mock('@features/document/store/document-store', () => ({
  useDocumentStore: {
    getState: () => ({
      openAgentConversation: mocks.openAgentConversation,
      activeAgentConversationId: mocks.activeAgentConversationId,
    }),
  },
}));

vi.mock('@features/memo/store/memo-store', () => ({
  useMemoStore: {
    getState: () => ({
      setActivePluginId: mocks.setActivePluginId,
      setSelectedMemo: mocks.setSelectedMemo,
    }),
  },
}));

vi.mock('@features/workspace/store/workspace-restore-store', () => ({
  useWorkspaceRestoreStore: {
    getState: () => ({
      selectAgentConversation: mocks.selectAgentConversation,
    }),
  },
}));

vi.mock('@features/workspace/store/workspace-store', () => ({
  useWorkspaceStore: {
    getState: () => ({
      navigation: { phase: 'committed', requestId: 1, target: { kind: 'plugin-workbench', plugin: { manifest: { id: 'plugin-a' } } }, pendingTarget: null, previousTarget: null, failure: null, retryToken: null },
      beginNavigation: mocks.beginNavigation,
      commitNavigation: mocks.commitNavigation,
      failNavigation: mocks.failNavigation,
      isCurrentNavigation: mocks.isCurrentNavigation,
    }),
  },
}));

import { selectAndOpenAgentConversation } from './agent-conversation-navigation';
import { useFourthColumnStore } from '@features/workspace/store/fourth-column-store';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';

describe('agent conversation navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFourthColumnStore.getState().reset();
  });

  it('commits the agent target and clears stale workspace selection', async () => {
    await selectAndOpenAgentConversation(' conversation-a ');

    expect(mocks.commitNavigation).toHaveBeenCalledWith(1, {
      kind: 'agent-conversation',
      instanceId: 'conversation-a',
    });
    expect(mocks.setActivePluginId).toHaveBeenCalledWith(null);
    expect(mocks.setSelectedMemo).toHaveBeenCalledWith(null);
    expect(mocks.openAgentConversation).toHaveBeenCalledWith('conversation-a', undefined);
    expect(mocks.selectAgentConversation).toHaveBeenCalledWith('conversation-a', true);
  });

  it('activates an existing fourth-column conversation without reopening it in the third column', async () => {
    useFourthColumnStore.getState().openTab({
      id: 'agent:conversation-a',
      title: 'Conversation A',
      icon: null,
      target: { kind: 'agent_conversation', instanceId: 'conversation-a' },
    });
    mocks.openAgentConversation.mockClear();

    await selectAndOpenAgentConversation('conversation-a');

    expect(mocks.openAgentConversation).not.toHaveBeenCalled();
    expect(useFourthColumnStore.getState()).toMatchObject({
      visible: true,
      activeTabId: 'agent:conversation-a',
    });
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('fourth-column');
    expect(mocks.selectAgentConversation).toHaveBeenCalledWith('conversation-a', false);
  });
});
