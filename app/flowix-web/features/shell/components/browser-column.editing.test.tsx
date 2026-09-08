import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { BrowserColumn } from './browser-column';
import { useBrowserColumnStore } from '@features/workspace/store/browser-column-store';
import { useWorkColumnStore } from '@features/workspace/store/work-column-store';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';

const resolveSurface = vi.hoisted(() => vi.fn((_tab: unknown, _readOnly: boolean, ..._options: unknown[]) => null));
vi.mock('@features/surface/browser-column-registry', () => ({
  resolveBrowserColumnSurface: resolveSurface,
  BrowserColumnSurfaceHost: () => null,
}));
vi.mock('./browser-column-header', () => ({ BrowserColumnHeader: () => null }));

it('does not force the right document read-only when the same memo is open on the left', async () => {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  const element = document.createElement('div');
  const root = createRoot(element);
  const previousNavigation = useWorkColumnStore.getState().navigation;
  const target = { kind: 'memo' as const, memoId: 'both', path: '/notes/both.md', notebookId: 'notes', notebookPath: '/notes', transitionId: 1 };
  const work = useWorkColumnStore.getState();
  work.commitNavigation(work.beginNavigation(target, null), target);
  const tab = { id: 'memo:both', title: 'Both', icon: null, target: { kind: 'memo' as const, memoId: 'both', filePath: target.path, notebookId: 'notes', notebookPath: '/notes' } };
  useBrowserColumnStore.getState().openTab(tab);
  try {
    await act(async () => root.render(<BrowserColumn width={500} layoutKey="test" onResize={() => {}} toolbarCollapsed={false} onToolbarCollapsedChange={() => {}} />));
    for (const host of ['main-third', 'browser-column'] as const) {
      await act(async () => useWorkspaceFocusStore.getState().focusHost(host));
      expect(resolveSurface.mock.lastCall?.[1]).toBe(false);
    }
  } finally {
    await act(async () => root.unmount());
    useBrowserColumnStore.getState().reset();
    useWorkColumnStore.setState({ navigation: previousNavigation });
    useWorkspaceFocusStore.getState().reset();
    environment.IS_REACT_ACT_ENVIRONMENT = false;
  }
});
