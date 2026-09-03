import { beforeEach, describe, expect, it } from 'vitest';
import {
  openFourthColumnAgentConversation,
  openFourthColumnMarkdown,
  openFourthColumnTarget,
} from './fourth-column-navigation';
import { useFourthColumnStore } from '@features/workspace/store/fourth-column-store';
import { useWorkspaceStore } from '@features/workspace/store/workspace-store';
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

describe('fourth column navigation', () => {
  beforeEach(() => {
    resetWorkspace();
    useFourthColumnStore.getState().reset();
  });

  it('opens local Markdown targets as fourth-column tabs', () => {
    const tabId = openFourthColumnMarkdown('/notes/plan.md');

    expect(tabId).toEqual({
      host: 'fourth-column',
      tabId: 'external_markdown:/notes/plan.md',
      alreadyOpen: false,
    });
    expect(useFourthColumnStore.getState().tabs[0]).toMatchObject({
      title: 'plan',
      target: { kind: 'external_markdown', filePath: '/notes/plan.md' },
    });
  });

  it('uses the Agent instance as the stable tab target', () => {
    openFourthColumnAgentConversation('agent-1');

    expect(useFourthColumnStore.getState()).toMatchObject({
      activeTabId: 'agent:agent-1',
      tabs: [{ title: 'Agent 会话', target: { kind: 'agent_conversation', instanceId: 'agent-1' } }],
    });
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('fourth-column');
  });

  it('supports replacing the active tab', () => {
    openFourthColumnMarkdown('/notes/old.md');
    openFourthColumnTarget({ kind: 'agent_conversation', instanceId: 'agent-2' }, 'replace-active');

    expect(useFourthColumnStore.getState().tabs.map((tab) => tab.target.kind)).toEqual(['agent_conversation']);
    expect(useFourthColumnStore.getState().activeTabId).toBe('agent:agent-2');
  });

  it('focuses an existing third-column document instead of opening a duplicate tab', () => {
    const workspace = useWorkspaceStore.getState();
    const requestId = workspace.beginNavigation({
      kind: 'external',
      path: '/notes/plan.md',
      scopePath: '/notes',
      transitionId: null,
    }, null);
    workspace.commitNavigation(requestId, {
      kind: 'external',
      path: '/notes/plan.md',
      scopePath: '/notes',
      transitionId: 1,
    });

    const result = openFourthColumnMarkdown('/notes/plan.md');

    expect(useFourthColumnStore.getState()).toMatchObject({
      tabs: [],
      visible: false,
    });
    expect(result).toEqual({ host: 'main-third', alreadyOpen: true });
    expect(useWorkspaceFocusStore.getState().focusedHostId).toBe('main-third');
  });
});
