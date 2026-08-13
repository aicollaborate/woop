import { beforeEach, describe, expect, it } from 'vitest';

import { useDocumentHistoryStore } from '@features/document/store/document-history-store';

describe('document history store', () => {
  beforeEach(() => {
    useDocumentHistoryStore.getState().clear();
  });

  it('keeps agent conversations as navigable history entries', () => {
    const conversation = {
      kind: 'agent-conversation' as const,
      instanceId: 'conversation-1',
      openedAt: 1,
    };
    const memo = {
      kind: 'memo' as const,
      memoId: 'memo-1',
      notebookId: 'notebook-1',
      notebookPath: '/notes',
      path: '/notes/memo-1.md',
      openedAt: 2,
    };

    useDocumentHistoryStore.getState().pushBack(memo);
    useDocumentHistoryStore.getState().commitBackNavigation(conversation);

    expect(useDocumentHistoryStore.getState().peekBack()).toBeNull();
    expect(useDocumentHistoryStore.getState().peekForward()).toEqual(conversation);
  });

  it('does not duplicate the same conversation at the top of a stack', () => {
    const conversation = {
      kind: 'agent-conversation' as const,
      instanceId: 'conversation-1',
      openedAt: 1,
    };

    useDocumentHistoryStore.getState().pushBack(conversation);
    useDocumentHistoryStore.getState().pushBack({ ...conversation, openedAt: 2 });

    expect(useDocumentHistoryStore.getState().backStack).toHaveLength(1);
  });
});
