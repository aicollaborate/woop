import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDocumentAutosave } from './use-document-autosave';
import { applyLoadedDocumentContent, recordDocumentEdit } from '../../store/document-session-service';
import { subscribeDocumentBufferChanges, getBuffer } from '../../store/buffer-registry';

const save = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock('@features/document', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  saveDocumentContent: save,
}));

describe('shared document autosave', () => {
  afterEach(() => { vi.useRealTimers(); save.mockClear(); });

  it('saves the latest shared draft when the outgoing surface timer fires', async () => {
    vi.useFakeTimers();
    const identity = { kind: 'memo' as const, id: 'shared-autosave' };
    applyLoadedDocumentContent(identity, '/notes/shared.md', '# Base');
    let onChange: ((content: string) => void) | undefined;
    const setState = vi.fn();
    const reloadDocument = vi.fn().mockResolvedValue(undefined);
    function Surface() {
      onChange = useDocumentAutosave({
        identity, filePath: '/notes/shared.md', memoId: identity.id,
        isExternalDocument: false, externalScopePath: null, setState, reloadDocument,
      }).handleChange;
      return null;
    }
    const element = document.createElement('div');
    const root = createRoot(element);
    const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    try {
      await act(async () => root.render(<Surface />));
      onChange?.('# Left edit');
      recordDocumentEdit(identity, '# Newer right edit');
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(save).toHaveBeenCalledWith(expect.objectContaining({ content: '# Newer right edit' }));
    } finally {
      await act(async () => root.unmount());
      environment.IS_REACT_ACT_ENVIRONMENT = false;
    }
  });

  it('publishes unsaved edits to both subscribers and preserves them when another surface loads', () => {
    const identity = { kind: 'memo' as const, id: 'shared-live' };
    applyLoadedDocumentContent(identity, '/notes/live.md', '# Disk');
    const left: string[] = [];
    const right: string[] = [];
    const subscribe = (view: string[]) => subscribeDocumentBufferChanges((changed) => {
      if (changed.kind === 'memo' && changed.id === identity.id) view.push(getBuffer(identity)!.content);
    });
    const stopLeft = subscribe(left);
    const stopRight = subscribe(right);
    try {
      recordDocumentEdit(identity, '# Unsaved');
      applyLoadedDocumentContent(identity, '/notes/live.md', '# Disk', { preservePending: true, setAsCurrent: false });
      recordDocumentEdit(identity, '# Edited from right');
      expect(left).toEqual(['# Unsaved', '# Unsaved', '# Edited from right']);
      expect(right).toEqual(left);
    } finally { stopLeft(); stopRight(); }
  });
});
