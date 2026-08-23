import { beforeEach, describe, expect, it } from 'vitest';

import { useWorkspaceRestoreStore } from './workspace-restore-store';

describe('workspace restore store', () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceRestoreStore.setState({
      version: 1,
      agentConversation: {
        selectedInstanceId: null,
        detailOpen: false,
      },
    });
  });

  it('records selection and an open detail together', () => {
    useWorkspaceRestoreStore.getState().selectAgentConversation(' conversation-a ');

    expect(useWorkspaceRestoreStore.getState().agentConversation).toEqual({
      selectedInstanceId: 'conversation-a',
      detailOpen: true,
    });
  });

  it('closes the detail while retaining the list selection', () => {
    useWorkspaceRestoreStore.getState().selectAgentConversation('conversation-a');
    useWorkspaceRestoreStore.getState().closeAgentConversationDetail();

    expect(useWorkspaceRestoreStore.getState().agentConversation).toEqual({
      selectedInstanceId: 'conversation-a',
      detailOpen: false,
    });
  });

  it('only clears a deleted conversation when it is selected', () => {
    useWorkspaceRestoreStore.getState().selectAgentConversation('conversation-a');
    useWorkspaceRestoreStore.getState().clearAgentConversation('conversation-b');
    expect(useWorkspaceRestoreStore.getState().agentConversation.selectedInstanceId)
      .toBe('conversation-a');

    useWorkspaceRestoreStore.getState().clearAgentConversation('conversation-a');
    expect(useWorkspaceRestoreStore.getState().agentConversation).toEqual({
      selectedInstanceId: null,
      detailOpen: false,
    });
  });
});
