import { create } from 'zustand';
import { workspaceContentIdentityKey } from './workspace-content-identity';
import { useWorkspaceFocusStore } from './workspace-focus-store';

export type FourthColumnTarget =
  | {
      kind: 'memo';
      memoId: string;
      notebookId: string;
      notebookPath: string;
      filePath: string;
    }
  | {
      kind: 'external_markdown';
      filePath: string;
    }
  | {
      kind: 'external_text';
      filePath: string;
      scopePath: string;
    }
  | {
      kind: 'agent_conversation';
      instanceId: string;
    };

export interface FourthColumnTab {
  id: string;
  title: string;
  icon: string | null;
  target: FourthColumnTarget;
}

export type FourthColumnOpenDisposition = 'focus-existing' | 'replace-active';

interface FourthColumnState {
  visible: boolean;
  splitRatio: number;
  tabs: FourthColumnTab[];
  activeTabId: string | null;
  setVisible: (visible: boolean) => void;
  setSplitRatio: (ratio: number) => void;
  openTab: (tab: FourthColumnTab, disposition?: FourthColumnOpenDisposition) => string;
  commitTab: (tabId: string) => void;
  closeTab: (tabId: string) => string | null;
  reorderTab: (tabId: string, beforeTabId: string | null) => void;
  reset: () => void;
}

/** The third and fourth document panes share the same minimum width. */
export const FOURTH_COLUMN_MIN_WIDTH = 360;
export const FOURTH_COLUMN_DEFAULT_SPLIT_RATIO = 0.5;

export function fourthColumnTargetKey(target: FourthColumnTarget): string | null {
  switch (target.kind) {
    case 'memo': return workspaceContentIdentityKey({ kind: 'memo', memoId: target.memoId });
    case 'external_markdown':
    case 'external_text': return workspaceContentIdentityKey({ kind: 'external', path: target.filePath });
    case 'agent_conversation': return workspaceContentIdentityKey({
      kind: 'agent-conversation',
      instanceId: target.instanceId,
    });
  }
}

function adjacentTabId(tabs: FourthColumnTab[], closingTabId: string): string | null {
  const index = tabs.findIndex((tab) => tab.id === closingTabId);
  if (index < 0) return null;
  return tabs[index - 1]?.id ?? tabs[index + 1]?.id ?? null;
}

export const useFourthColumnStore = create<FourthColumnState>((set, get) => ({
  visible: false,
  splitRatio: FOURTH_COLUMN_DEFAULT_SPLIT_RATIO,
  tabs: [],
  activeTabId: null,
  setVisible: (visible) => {
    const focus = useWorkspaceFocusStore.getState();
    if (visible) focus.focusHost('fourth-column');
    else if (focus.focusedHostId === 'fourth-column') focus.focusHost('main-third');
    set({ visible });
  },
  setSplitRatio: (splitRatio) => set({
    splitRatio: Number.isFinite(splitRatio)
      ? Math.min(0.95, Math.max(0.05, splitRatio))
      : FOURTH_COLUMN_DEFAULT_SPLIT_RATIO,
  }),
  openTab: (incoming, disposition = 'focus-existing') => {
    const state = get();
    const incomingKey = fourthColumnTargetKey(incoming.target);
    const existing = incomingKey
      ? state.tabs.find((tab) => fourthColumnTargetKey(tab.target) === incomingKey)
      : undefined;
    if (existing) {
      const tabs = disposition === 'replace-active'
        && state.activeTabId
        && state.activeTabId !== existing.id
        ? state.tabs.filter((tab) => tab.id !== state.activeTabId)
        : state.tabs;
      useWorkspaceFocusStore.getState().focusHost('fourth-column');
      set({ visible: true, tabs, activeTabId: existing.id });
      return existing.id;
    }

    const id = incoming.id;
    const tab = { ...incoming, id };
    const tabs = disposition === 'replace-active' && state.activeTabId
      ? state.tabs.map((candidate) => candidate.id === state.activeTabId ? tab : candidate)
      : [...state.tabs, tab];
    useWorkspaceFocusStore.getState().focusHost('fourth-column');
    set({
      visible: true,
      tabs,
      activeTabId: id,
    });
    return id;
  },
  commitTab: (tabId) => {
    if (!get().tabs.some((tab) => tab.id === tabId)) return;
    useWorkspaceFocusStore.getState().focusHost('fourth-column');
    set({ visible: true, activeTabId: tabId });
  },
  closeTab: (tabId) => {
    const state = get();
    const nextActiveTabId = state.activeTabId === tabId
      ? adjacentTabId(state.tabs, tabId)
      : state.activeTabId;
    const tabs = state.tabs.filter((tab) => tab.id !== tabId);
    useWorkspaceFocusStore.getState().focusHost(tabs.length > 0 ? 'fourth-column' : 'main-third');
    set({
      tabs,
      activeTabId: nextActiveTabId,
      visible: tabs.length > 0,
    });
    return nextActiveTabId;
  },
  reorderTab: (tabId, beforeTabId) => set((state) => {
    const sourceIndex = state.tabs.findIndex((tab) => tab.id === tabId);
    if (sourceIndex < 0 || beforeTabId === tabId) return state;
    const tabs = [...state.tabs];
    const [tab] = tabs.splice(sourceIndex, 1);
    const targetIndex = beforeTabId
      ? tabs.findIndex((candidate) => candidate.id === beforeTabId)
      : tabs.length;
    tabs.splice(targetIndex < 0 ? tabs.length : targetIndex, 0, tab);
    return { tabs };
  }),
  reset: () => {
    useWorkspaceFocusStore.getState().reset();
    set({
      visible: false,
      splitRatio: FOURTH_COLUMN_DEFAULT_SPLIT_RATIO,
      tabs: [],
      activeTabId: null,
    });
  },
}));
