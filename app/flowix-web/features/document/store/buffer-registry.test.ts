import { describe, expect, it, vi } from 'vitest';

import {
  applyLoadedDocumentContent,
  recordDocumentEdit,
} from './document-session-service';
import { subscribeDocumentBufferChanges } from './buffer-registry';

describe('document buffer change notifications', () => {
  it('notifies listeners when a memo is loaded and edited', () => {
    const identity = { kind: 'memo' as const, id: 'memo-buffer-events' };
    const listener = vi.fn();
    const unsubscribe = subscribeDocumentBufferChanges(listener);

    try {
      applyLoadedDocumentContent(identity, '/notes/events.md', 'base content');
      recordDocumentEdit(identity, 'local edit');
    } finally {
      unsubscribe();
    }

    expect(listener).toHaveBeenNthCalledWith(1, identity, 'loaded');
    expect(listener).toHaveBeenNthCalledWith(2, identity, 'edited');
  });

  it('stops notifying after unsubscribe', () => {
    const identity = { kind: 'memo' as const, id: 'memo-buffer-unsubscribe' };
    const listener = vi.fn();
    const unsubscribe = subscribeDocumentBufferChanges(listener);
    unsubscribe();

    recordDocumentEdit(identity, 'ignored edit');

    expect(listener).not.toHaveBeenCalled();
  });
});
