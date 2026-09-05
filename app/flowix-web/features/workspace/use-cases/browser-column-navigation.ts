import { displayTitleFromFilename } from '@/lib/utils';
import { joinNotebookMemoPath } from '@/lib/path';
import { canonicalUrl } from '@features/workspace/store/workspace-content-identity';
import type { MemoItem, Notebook } from '@features/memo';
import { memos as memosClient } from '@platform/tauri/client';
import {
  getPluginNoteInfo,
  type PluginArtifactRendererId,
} from '@features/plugin/plugin-note';
import {
  useBrowserColumnStore,
  type BrowserColumnOpenDisposition,
  type BrowserColumnTab,
  type BrowserColumnTarget,
} from '@features/workspace/store/browser-column-store';
import {
  activateExistingWorkspaceContent,
  activateExistingWorkspaceContentAsync,
  findExistingWorkspaceContent,
  browserColumnTargetIdentity,
} from './workspace-content-activation';
import {
  enqueueBrowserColumnNavigation,
  flushActiveBrowserColumnDocument,
} from './browser-column-coordinator';
import {
  openAgentTarget,
  openArtifactTarget,
  openExternalTarget,
  openMemoTarget,
  openWebTarget,
} from './workspace-navigation';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';

export type BrowserColumnOpenResult =
  | { host: 'main-third'; alreadyOpen: true }
  | { host: 'browser-column'; tabId: string; alreadyOpen: boolean };

function openResult(
  location: ReturnType<typeof activateExistingWorkspaceContent>,
): BrowserColumnOpenResult | null {
  if (!location) return null;
  return location.host === 'main-third'
    ? { host: 'main-third', alreadyOpen: true }
    : { host: 'browser-column', tabId: location.tabId, alreadyOpen: true };
}

function targetTabTitle(target: BrowserColumnTarget): string {
  const filenameFromPath = (path: string) => path.split(/[\\/]/).pop() ?? path;

  switch (target.kind) {
    case 'memo':
    case 'file':
      return displayTitleFromFilename(filenameFromPath(target.filePath));
    case 'file-browser':
      return filenameFromPath(target.folderPath) || '文件';
    case 'web':
      try {
        return new URL(target.url).hostname || target.url;
      } catch {
        return target.url;
      }
    case 'agent_conversation':
      return 'Agent 会话';
    case 'artifact':
      return '插件产物';
  }
}

function targetTabIcon(target: BrowserColumnTarget): string | null {
  if (target.kind !== 'web') return null;
  try {
    const parsed = new URL(target.url);
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

export function openBrowserColumnTarget(
  target: BrowserColumnTarget,
  disposition: BrowserColumnOpenDisposition = 'focus-existing',
): Promise<BrowserColumnOpenResult | null> {
  const id = target.kind === 'memo'
    ? `memo:${target.memoId}`
    : target.kind === 'agent_conversation'
      ? `agent:${target.instanceId}`
      : target.kind === 'web'
        ? `web:${canonicalUrl(target.url) ?? target.url}`
        : target.kind === 'file-browser'
          ? `file-browser:${target.folderPath}`
        : target.kind === 'artifact'
          ? `artifact:${target.pointerMemoId}`
          : `file:${target.filePath}`;

  return enqueueBrowserColumnNavigation(async () => {
    if (disposition === 'focus-existing') {
      const existing = findExistingWorkspaceContent(browserColumnTargetIdentity(target));
      if (existing?.host === 'main-third') {
        activateExistingWorkspaceContent(browserColumnTargetIdentity(target));
        return openResult(existing);
      }
      if (existing?.host === 'browser-column') {
        useBrowserColumnStore.getState().commitTab(existing.tabId);
        return { host: 'browser-column', tabId: existing.tabId, alreadyOpen: true };
      }
    }

    const tabId = useBrowserColumnStore.getState().openTab({
      id,
      title: targetTabTitle(target),
      icon: targetTabIcon(target),
      target,
    }, disposition);
    return { host: 'browser-column', tabId, alreadyOpen: false };
  });
}

export function openBrowserColumnMemo(
  memo: MemoItem,
  notebook: Notebook | null,
  disposition: BrowserColumnOpenDisposition = 'focus-existing',
): Promise<BrowserColumnOpenResult | null> {
  const pluginNote = getPluginNoteInfo(memo);
  if (pluginNote) {
    return openBrowserColumnTarget({
      kind: 'artifact',
      pointerMemoId: memo.id,
      renderer: pluginNote.renderer,
    }, disposition);
  }

  const filePath = notebook?.path
    ? joinNotebookMemoPath(notebook.path, memo.filename) ?? memo.filename
    : memo.filename;

  return openBrowserColumnTarget({
    kind: 'memo',
    memoId: memo.id,
    notebookId: notebook?.id ?? '',
    notebookPath: notebook?.path ?? '',
    filePath,
  }, disposition);
}

export async function openBrowserColumnMemoById(memoId: string): Promise<BrowserColumnOpenResult> {
  const identity = { kind: 'memo' as const, memoId };
  const existing = await activateExistingWorkspaceContentAsync(identity);
  if (!existing && findExistingWorkspaceContent(identity)) {
    throw new Error(`Memo tab activation was cancelled: ${memoId}`);
  }
  const result = openResult(existing);
  if (result) return result;

  // `MemoItem` deliberately has no notebook field. Resolving the path from
  // the selected notebook would open a background-created memo in the wrong
  // notebook, so use the backend's authoritative memo session response.
  const session = await memosClient.openMemoSession(memoId);
  if (!session) throw new Error(`Memo is unavailable: ${memoId}`);

  const pluginNote = getPluginNoteInfo(session.memo);
  const opened = await openBrowserColumnTarget(pluginNote
    ? {
        kind: 'artifact',
        pointerMemoId: session.memo.id,
        renderer: pluginNote.renderer,
      }
    : {
        kind: 'memo',
        memoId: session.memo.id,
        notebookId: session.notebookId,
        notebookPath: session.notebookPath,
        filePath: session.path,
      });
  if (!opened) throw new Error(`Memo tab activation was cancelled: ${memoId}`);
  return opened;
}

export function openBrowserColumnMarkdown(filePath: string): Promise<BrowserColumnOpenResult | null> {
  return openBrowserColumnTarget({ kind: 'file', filePath, scopePath: null });
}

export function openBrowserColumnArtifact(
  pointerMemoId: string,
  renderer: PluginArtifactRendererId | null,
): Promise<BrowserColumnOpenResult | null> {
  return openBrowserColumnTarget({ kind: 'artifact', pointerMemoId, renderer });
}

export function openBrowserColumnText(filePath: string, scopePath: string): Promise<BrowserColumnOpenResult | null> {
  return openBrowserColumnTarget({ kind: 'file', filePath, scopePath });
}

export function openBrowserColumnFileBrowser(folderPath: string): Promise<BrowserColumnOpenResult | null> {
  return openBrowserColumnTarget({
    kind: 'file-browser',
    folderPath,
    activeFilePath: null,
    fileTreeVisible: true,
    fileTreeWidth: 280,
  });
}

export function openBrowserColumnWebpage(url: string): Promise<BrowserColumnOpenResult | null> {
  const normalized = canonicalUrl(url);
  if (!normalized) return Promise.reject(new Error(`Unsupported webpage URL: ${url}`));
  return openBrowserColumnTarget({ kind: 'web', url: normalized });
}

export function openBrowserColumnAgentConversation(instanceId: string): Promise<BrowserColumnOpenResult | null> {
  return openBrowserColumnTarget({ kind: 'agent_conversation', instanceId });
}

function restoreBrowserColumnTab(
  tab: BrowserColumnTab,
  originalIndex: number,
  originalActiveTabId: string | null,
): void {
  const store = useBrowserColumnStore.getState();
  if (!store.tabs.some((candidate) => candidate.id === tab.id)) {
    store.openTab(tab);
  }

  const restored = useBrowserColumnStore.getState();
  const currentIndex = restored.tabs.findIndex((candidate) => candidate.id === tab.id);
  if (currentIndex >= 0 && currentIndex !== originalIndex) {
    const beforeTabId = restored.tabs[originalIndex]?.id ?? null;
    restored.reorderTab(tab.id, beforeTabId === tab.id ? null : beforeTabId);
  }

  const activeTabStillExists = originalActiveTabId !== null
    && useBrowserColumnStore.getState().tabs.some((candidate) => candidate.id === originalActiveTabId);
  if (activeTabStillExists) {
    useBrowserColumnStore.getState().commitTab(originalActiveTabId);
  }
}

/** Move a BrowserColumn tab to the left work column. */
export function openBrowserColumnTabInWorkColumn(tabId: string): Promise<boolean | null> {
  return enqueueBrowserColumnNavigation(async () => {
    const before = useBrowserColumnStore.getState();
    const originalIndex = before.tabs.findIndex((tab) => tab.id === tabId);
    if (originalIndex < 0) return false;
    const tab = before.tabs[originalIndex];
    const originalActiveTabId = before.activeTabId;

    // Remove the tab before invoking the normal work-column navigation
    // facade. Its duplicate detection must see the target as no longer owned
    // by the BrowserColumn, otherwise it would simply reactivate this tab.
    useBrowserColumnStore.getState().closeTab(tabId);

    try {
      switch (tab.target.kind) {
        case 'memo':
          await openMemoTarget({
            memoId: tab.target.memoId,
            path: tab.target.filePath,
            notebookId: tab.target.notebookId || null,
            notebookPath: tab.target.notebookPath || null,
          });
          break;
        case 'file':
          await openExternalTarget(tab.target.filePath, {
            scopePath: tab.target.scopePath,
          });
          break;
        case 'file-browser':
          if (tab.target.activeFilePath) {
            await openExternalTarget(tab.target.activeFilePath, {
              scopePath: tab.target.folderPath,
            });
          }
          break;
        case 'web':
          await openWebTarget(tab.target.url);
          break;
        case 'artifact':
          await openArtifactTarget({
            pointerMemoId: tab.target.pointerMemoId,
            renderer: tab.target.renderer,
          });
          break;
        case 'agent_conversation':
          await openAgentTarget(tab.target.instanceId);
          break;
      }
      useWorkspaceFocusStore.getState().focusHost('main-third');
      return true;
    } catch (error) {
      restoreBrowserColumnTab(tab, originalIndex, originalActiveTabId);
      throw error;
    }
  });
}

/** Keep durable BrowserColumn memo targets aligned with backend renames. */
export function replaceBrowserColumnMemoPath(memoId: string, path: string): void {
  useBrowserColumnStore.getState().replaceMemoPath(memoId, path);
}

/** Remove both a memo tab and any artifact tab pointing at that memo. */
export function removeBrowserColumnTabsByMemoId(memoId: string): string[] {
  return useBrowserColumnStore.getState().removeTabsByMemoId(memoId);
}

/** Flush only when the memo being deleted owns the active BrowserColumn tab. */
export function flushBrowserColumnMemo(memoId: string): Promise<boolean | null> {
  return enqueueBrowserColumnNavigation(async () => {
    const active = useBrowserColumnStore.getState().tabs.find(
      (tab) => tab.id === useBrowserColumnStore.getState().activeTabId,
    );
    const ownsMemo = active?.target.kind === 'memo'
      ? active.target.memoId === memoId
      : active?.target.kind === 'artifact'
        ? active.target.pointerMemoId === memoId
        : false;
    return !ownsMemo || await flushActiveBrowserColumnDocument();
  }, { flush: false });
}
