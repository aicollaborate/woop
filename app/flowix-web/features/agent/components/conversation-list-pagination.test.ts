import { describe, expect, it } from 'vitest';

import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';
import {
  EMPTY_CONVERSATION_PAGE_STATE,
  mergeConversationPage,
  updateConversationTitle,
} from './conversation-list-pagination';

function conversation(
  instanceId: string,
  updatedAt: number,
  threadId: string | null = instanceId,
): AgentConversationInstance {
  return {
    instanceId,
    agentType: 'codex',
    title: instanceId,
    threadId,
    source: { kind: 'dedicated', notebookId: 'nb-1' },
    createdAt: updatedAt,
    updatedAt,
  };
}

describe('conversation list pagination state', () => {
  it('appends pages in backend order and collapses duplicate thread identities', () => {
    const first = mergeConversationPage(EMPTY_CONVERSATION_PAGE_STATE, [
      conversation('new', 300),
      conversation('same-thread-old', 200, 'shared'),
    ]);
    const second = mergeConversationPage(first, [
      conversation('same-thread-new', 250, 'shared'),
      conversation('old', 100),
    ]);

    expect(second.orderedIdentities).toEqual([
      'thread:new',
      'thread:shared',
      'thread:old',
    ]);
    expect(second.itemsByIdentity['thread:shared']?.instanceId).toBe('same-thread-new');
  });

  it('updates a row without rebuilding the page from an offset', () => {
    const page = mergeConversationPage(EMPTY_CONVERSATION_PAGE_STATE, [
      conversation('old', 100),
      conversation('new', 200),
    ]);
    const renamed = updateConversationTitle(page, 'old', 'Renamed', 400);

    expect(renamed.orderedIdentities).toEqual(['thread:old', 'thread:new']);
    expect(renamed.itemsByIdentity['thread:old']?.title).toBe('Renamed');
  });
});
