import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openBrowserColumnAgentConversation,
  openBrowserColumnFileBrowser,
  openBrowserColumnMemo,
  openBrowserColumnMarkdown,
  openBrowserColumnTabInWorkColumn,
  openBrowserColumnTarget,
  openBrowserColumnWebpage,
  openWorkColumnTargetInBrowserColumn,
} from './browser-column-navigation';
import { useBrowserColumnStore } from '@features/workspace/store/browser-column-store';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';
import {
  registerBrowserColumnDocumentFlush,
  resetBrowserColumnCoordinator,
} from './browser-column-coordinator';
import type { MemoItem } from '@/types/memo-item';

function resetWorkspace() {
  useWorkColumnStore.setState({
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

describe('browser column navigation', () => {
  beforeEach(() => {
    resetWorkspace();
    resetBrowserColumnCoordinator();
    useBrowserColumnStore.getState().reset();
  });

  it('opens local Markdown targets as browser-column tabs', async () => {
    const tabId = await openBrowserColumnMarkdown('/notes/plan.md');

    expect(tabId).toEqual({
      host: 'browser-column',
      tabId: 'file:/notes/plan.md',
      alreadyOpen: false,
    });
    expect(useBrowserColumnStore.getState().tabs[0]).toMatchObject({
      title: 'plan',
      target: { kind: 'file', filePath: '/notes/plan.md', scopePath: null },
    });
  });

  it('opens one file-browser tab per folder and switches its active file', async () => {
    await openBrowserColumnFileBrowser('/workspace');
    await openBrowserColumnFileBrowser('/workspace');

    const store = useBrowserColumnStore.getState();
    expect(store.tabs).toHaveLength(1);
    expect(store.tabs[0].target).toMatchObject({
      kind: 'file-browser',
      folderPath: '/workspace',
      activeFilePath: null,
    });

    store.selectFileBrowserFile(store.tabs[0].id, '/workspace/src/main.ts');
    expect(useBrowserColumnStore.getState().tabs[0].target).toMatchObject({
      kind: 'file-browser',
      activeFilePath: '/workspace/src/main.ts',
    });
  });

  it('switches the current file-browser tab folder without changing other tabs', async () => {
    await openBrowserColumnFileBrowser('/workspace');
    await openBrowserColumnFileBrowser('/other');

    const store = useBrowserColumnStore.getState();
    const otherTabId = store.tabs.find((tab) => tab.target.kind === 'file-browser' && tab.target.folderPath === '/other')?.id;
    const workspaceTab = store.tabs.find((tab) => tab.target.kind === 'file-browser' && tab.target.folderPath === '/workspace');
    expect(otherTabId).toBeDefined();
    expect(workspaceTab).toBeDefined();
    if (!otherTabId || !workspaceTab) return;

    store.selectFileBrowserFile(otherTabId, '/other/readme.md');
    store.switchFileBrowserFolder(otherTabId, '/next');

    expect(useBrowserColumnStore.getState().tabs).toEqual([
      workspaceTab,
      expect.objectContaining({
        id: otherTabId,
        title: 'next',
        target: expect.objectContaining({
          kind: 'file-browser',
          folderPath: '/next',
          activeFilePath: null,
        }),
      }),
    ]);
  });

  it('uses the Agent instance as the stable tab target', async () => {
    await openBrowserColumnAgentConversation('agent-1');

    expect(useBrowserColumnStore.getState()).toMatchObject({
      activeTabId: 'agent:agent-1',
      tabs: [{ title: 'Agent 会话', target: { kind: 'agent_conversation', instanceId: 'agent-1' } }],
    });
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('browser-column');
  });

  it('opens webpages as browser-column tabs and reuses the existing tab', async () => {
    const first = await openBrowserColumnWebpage('https://example.com/docs');
    const second = await openBrowserColumnWebpage('https://example.com/docs');

    expect(first).toEqual({
      host: 'browser-column',
      tabId: 'web:https://example.com/docs',
      alreadyOpen: false,
    });
    expect(second).toEqual({
      host: 'browser-column',
      tabId: 'web:https://example.com/docs',
      alreadyOpen: true,
    });
    expect(useBrowserColumnStore.getState().tabs[0]).toMatchObject({
      title: 'example.com',
      target: { kind: 'web', url: 'https://example.com/docs' },
    });
  });

  it('moves a browser tab to the left work column', async () => {
    await openBrowserColumnWebpage('https://example.com/docs');
    await openBrowserColumnWebpage('https://flowix.dev/');

    const moved = await openBrowserColumnTabInWorkColumn('web:https://example.com/docs');

    expect(moved).toBe(true);
    expect(useBrowserColumnStore.getState()).toMatchObject({
      tabs: [{ id: 'web:https://flowix.dev/' }],
      activeTabId: 'web:https://flowix.dev/',
      visible: true,
    });
    expect(useWorkColumnStore.getState().navigation.target).toEqual({
      kind: 'web',
      url: 'https://example.com/docs',
    });
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('main-third');
  });

  it('keeps the tab when its document cannot be flushed before moving', async () => {
    await openBrowserColumnMarkdown('/notes/plan.md');
    registerBrowserColumnDocumentFlush(
      'file:/notes/plan.md',
      vi.fn().mockResolvedValue(false),
    );

    const moved = await openBrowserColumnTabInWorkColumn('file:/notes/plan.md');

    expect(moved).toBeNull();
    expect(useBrowserColumnStore.getState().tabs[0]).toMatchObject({
      id: 'file:/notes/plan.md',
      target: { kind: 'file', filePath: '/notes/plan.md' },
    });
  });

  it('supports replacing the active tab', async () => {
    await openBrowserColumnMarkdown('/notes/old.md');
    await openBrowserColumnTarget({ kind: 'agent_conversation', instanceId: 'agent-2' }, 'replace-active');

    expect(useBrowserColumnStore.getState().tabs.map((tab) => tab.target.kind)).toEqual(['agent_conversation']);
    expect(useBrowserColumnStore.getState().activeTabId).toBe('agent:agent-2');
  });

  it('focuses an existing work-column document instead of opening a duplicate tab', async () => {
    const workColumn = useWorkColumnStore.getState();
    const requestId = workColumn.beginNavigation({
      kind: 'external',
      path: '/notes/plan.md',
      scopePath: '/notes',
      transitionId: null,
    }, null);
    workColumn.commitNavigation(requestId, {
      kind: 'external',
      path: '/notes/plan.md',
      scopePath: '/notes',
      transitionId: 1,
    });

    const result = await openBrowserColumnMarkdown('/notes/plan.md');

    expect(useBrowserColumnStore.getState()).toMatchObject({
      tabs: [],
      visible: false,
    });
    expect(result).toEqual({ host: 'main-third', alreadyOpen: true });
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('main-third');
  });

  it('opens the active work-column target in the right column while keeping the left target', async () => {
    const target = {
      kind: 'external' as const,
      path: '/notes/plan.md',
      scopePath: '/notes',
      transitionId: 1,
    };
    const workColumn = useWorkColumnStore.getState();
    const requestId = workColumn.beginNavigation(target, null);
    workColumn.commitNavigation(requestId, target);

    const result = await openWorkColumnTargetInBrowserColumn(target);

    expect(result).toEqual({
      host: 'browser-column',
      tabId: 'file:/notes/plan.md',
      alreadyOpen: false,
    });
    expect(useBrowserColumnStore.getState().tabs[0]).toMatchObject({
      target: { kind: 'file', filePath: '/notes/plan.md', scopePath: '/notes' },
    });
    expect(useWorkColumnStore.getState().navigation.target).toEqual({ kind: 'empty' });
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('browser-column');
  });

  it('flushes the active editor before a programmatic tab replacement', async () => {
    await openBrowserColumnMarkdown('/notes/old.md');
    const flush = vi.fn().mockResolvedValue(true);
    registerBrowserColumnDocumentFlush('file:/notes/old.md', flush);

    await openBrowserColumnTarget(
      { kind: 'agent_conversation', instanceId: 'agent-2' },
      'replace-active',
    );

    expect(flush).toHaveBeenCalledOnce();
    expect(useBrowserColumnStore.getState().tabs.map((tab) => tab.target.kind)).toEqual([
      'agent_conversation',
    ]);
  });

  it('keeps the current tab when its editor refuses to flush', async () => {
    await openBrowserColumnMarkdown('/notes/old.md');
    registerBrowserColumnDocumentFlush(
      'file:/notes/old.md',
      vi.fn().mockResolvedValue(false),
    );

    const result = await openBrowserColumnTarget(
      { kind: 'agent_conversation', instanceId: 'agent-2' },
      'replace-active',
    );

    expect(result).toBeNull();
    expect(useBrowserColumnStore.getState().tabs[0].target).toMatchObject({
      kind: 'file',
      filePath: '/notes/old.md',
    });
  });

  it('opens plugin pointer notes as artifact tabs', async () => {
    const memo: MemoItem = {
      id: 'artifact-memo',
      filename: 'Roadmap.md',
      preview: '',
      tags: [],
      todos: [],
      agents: [],
      createdAt: 1,
      updatedAt: 1,
      favorited: false,
      icon: null,
      colors: [],
      properties: {
        flowix_note_type: 'mindmap',
        flowix_plugin: 'mindmap',
        flowix_artifact: { renderer: 'markmap' },
      },
    };

    await openBrowserColumnMemo(memo, null);

    expect(useBrowserColumnStore.getState().tabs[0].target).toEqual({
      kind: 'artifact',
      pointerMemoId: 'artifact-memo',
      renderer: 'markmap',
    });
  });
});
