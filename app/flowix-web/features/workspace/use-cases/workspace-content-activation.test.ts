import { beforeEach, describe, expect, it } from 'vitest';

import { useFourthColumnStore } from '@features/workspace/store/fourth-column-store';
import { useWorkspaceStore } from '@features/workspace/store/workspace-store';
import { activateExistingWorkspaceContent } from './workspace-content-activation';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';

function resetWorkspace() {
  useWorkspaceStore.setState({
    navigation: {
      phase: 'idle',
      requestId: 0,
      target: { kind: 'empty' },
      pendingTarget: null,
      previousTarget: null,
      failure: null,
      retryToken: null,
    },
  });
}

function commitThirdTarget(target: Parameters<ReturnType<typeof useWorkspaceStore.getState>['beginNavigation']>[0]) {
  const store = useWorkspaceStore.getState();
  const requestId = store.beginNavigation(target, null);
  store.commitNavigation(requestId, target);
}

describe('workspace content activation', () => {
  beforeEach(() => {
    resetWorkspace();
    useFourthColumnStore.getState().reset();
  });

  it('focuses the third column when the memo is already its active target', () => {
    commitThirdTarget({
      kind: 'memo',
      memoId: 'memo-a',
      path: '/notes/a.md',
      notebookId: 'notebook-a',
      notebookPath: '/notes',
      transitionId: 1,
    });
    useWorkspaceFocusStore.getState().focusHost('fourth-column');

    expect(activateExistingWorkspaceContent({ kind: 'memo', memoId: 'memo-a' })).toEqual({
      host: 'main-third',
      state: 'active',
    });
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('main-third');
  });

  it('reveals the fourth column and activates its matching tab and host', () => {
    const fourth = useFourthColumnStore.getState();
    fourth.openTab({
      id: 'memo:b',
      title: 'B',
      icon: null,
      target: {
        kind: 'memo',
        memoId: 'b',
        notebookId: 'notebook-a',
        notebookPath: '/notes',
        filePath: '/notes/b.md',
      },
    });
    fourth.openTab({
      id: 'memo:a',
      title: 'A',
      icon: null,
      target: {
        kind: 'memo',
        memoId: 'a',
        notebookId: 'notebook-a',
        notebookPath: '/notes',
        filePath: '/notes/a.md',
      },
    });
    fourth.commitTab('memo:b');
    fourth.setVisible(false);

    expect(activateExistingWorkspaceContent({ kind: 'memo', memoId: 'a' })).toEqual({
      host: 'fourth-column',
      tabId: 'memo:a',
    });
    expect(useFourthColumnStore.getState()).toMatchObject({
      visible: true,
      activeTabId: 'memo:a',
    });
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('fourth-column');
  });

  it('treats Markdown and text views of the same canonical path as one document', () => {
    useFourthColumnStore.getState().openTab({
      id: 'external_text:/notes/a.md',
      title: 'A',
      icon: null,
      target: {
        kind: 'external_text',
        filePath: '/notes\\a.md',
        scopePath: '/notes',
      },
    });

    expect(activateExistingWorkspaceContent({
      kind: 'external',
      path: '/notes/a.md',
    })).toEqual({
      host: 'fourth-column',
      tabId: 'external_text:/notes/a.md',
    });
  });

  it('prefers the third column when legacy state contains the target twice', () => {
    commitThirdTarget({ kind: 'agent-conversation', instanceId: 'agent-a' });
    useFourthColumnStore.getState().openTab({
      id: 'agent:agent-a',
      title: 'Agent A',
      icon: null,
      target: { kind: 'agent_conversation', instanceId: 'agent-a' },
    });

    expect(activateExistingWorkspaceContent({
      kind: 'agent-conversation',
      instanceId: 'agent-a',
    })).toEqual({ host: 'main-third', state: 'active' });
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('main-third');
  });

  it('treats a pending third-column open as existing content', () => {
    useWorkspaceStore.getState().beginNavigation({
      kind: 'memo',
      memoId: 'memo-pending',
      path: '/notes/pending.md',
      notebookId: 'notebook-a',
      notebookPath: '/notes',
      transitionId: null,
    }, null);

    expect(activateExistingWorkspaceContent({
      kind: 'memo',
      memoId: 'memo-pending',
    })).toEqual({ host: 'main-third', state: 'pending' });
    expect(useFourthColumnStore.getState().tabs).toEqual([]);
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('main-third');
  });
});
