import { useEffect, useMemo, useRef, useState } from 'react';
import { AgentConversationDetail } from '@features/agent/components/agent-conversation-detail';
import { DocumentContainer } from '@features/document/components/document-container';
import { useDocumentStore } from '@features/document';
import {
  useFourthColumnStore,
  type FourthColumnTab,
} from '@features/workspace/store/fourth-column-store';
import { FourthColumnHeader } from './fourth-column-header';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';

const FOURTH_COLUMN_SPLIT_RATIO_STORAGE_KEY = 'flowix.workspace.fourth-column.split-ratio';

function FourthColumnTabContent({ tab, readOnly }: { tab: FourthColumnTab; readOnly: boolean }) {
  const [searchPanelOpen, setSearchPanelOpen] = useState(false);
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false);

  switch (tab.target.kind) {
    case 'memo':
      return (
        <DocumentContainer
          filePath={tab.target.filePath}
          memoId={tab.target.memoId}
          notebookId={tab.target.notebookId || null}
          notebookPath={tab.target.notebookPath || null}
          documentSessionMode="isolated"
          readOnly={readOnly}
          searchPanelOpen={searchPanelOpen}
          onSearchPanelOpenChange={setSearchPanelOpen}
          toolbarCollapsed={toolbarCollapsed}
          onToolbarCollapsedChange={setToolbarCollapsed}
        />
      );
    case 'external_markdown':
      return (
        <DocumentContainer
          filePath={tab.target.filePath}
          isExternalDocument
          documentSessionMode="isolated"
          searchPanelOpen={searchPanelOpen}
          onSearchPanelOpenChange={setSearchPanelOpen}
          toolbarCollapsed={toolbarCollapsed}
          onToolbarCollapsedChange={setToolbarCollapsed}
        />
      );
    case 'external_text':
      return (
        <DocumentContainer
          filePath={tab.target.filePath}
          isExternalDocument
          externalScopePath={tab.target.scopePath}
          documentSessionMode="isolated"
          searchPanelOpen={searchPanelOpen}
          onSearchPanelOpenChange={setSearchPanelOpen}
          toolbarCollapsed={toolbarCollapsed}
          onToolbarCollapsedChange={setToolbarCollapsed}
        />
      );
    case 'agent_conversation':
      return <AgentConversationDetail instanceId={tab.target.instanceId} />;
  }
}

export interface FourthColumnProps {
  width: number;
  onResize: (width: number) => void;
}

export function FourthColumn({ width, onResize }: FourthColumnProps) {
  const splitRatio = useFourthColumnStore((state) => state.splitRatio);
  const setSplitRatio = useFourthColumnStore((state) => state.setSplitRatio);
  const tabs = useFourthColumnStore((state) => state.tabs);
  const activeTabId = useFourthColumnStore((state) => state.activeTabId);
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId, tabs],
  );
  const selectTab = useFourthColumnStore((state) => state.commitTab);
  const closeTab = useFourthColumnStore((state) => state.closeTab);
  const reorderTab = useFourthColumnStore((state) => state.reorderTab);
  const focusHost = useWorkspaceFocusStore((state) => state.focusHost);
  const focusedHostId = useWorkspaceFocusStore((state) => state.focusedHostId);
  const mainMemoId = useDocumentStore((state) => state.activeMemoSession?.memoId ?? null);
  const activeMemoId = activeTab?.target.kind === 'memo' ? activeTab.target.memoId : null;
  const activeMemoHasDuplicateTab = activeMemoId !== null
    && tabs.filter((tab) => tab.target.kind === 'memo' && tab.target.memoId === activeMemoId).length > 1;
  const activeMemoIsOpenInMain = activeMemoId !== null && activeMemoId === mainMemoId;
  const [isResizing, setIsResizing] = useState(false);
  const restoredSplitRatioRef = useRef(false);
  const resizeStartRef = useRef({ x: 0, width });

  useEffect(() => {
    try {
      const storedRatio = Number(localStorage.getItem(FOURTH_COLUMN_SPLIT_RATIO_STORAGE_KEY));
      if (Number.isFinite(storedRatio)) setSplitRatio(storedRatio);
    } catch {
      // Browser previews and restricted WebViews may deny localStorage.
    } finally {
      restoredSplitRatioRef.current = true;
    }
  }, [setSplitRatio]);

  useEffect(() => {
    if (!restoredSplitRatioRef.current) return;
    try {
      localStorage.setItem(FOURTH_COLUMN_SPLIT_RATIO_STORAGE_KEY, String(splitRatio));
    } catch {
      // Split ratio persistence is best-effort and must not affect editing.
    }
  }, [splitRatio]);

  useEffect(() => {
    if (!isResizing) return;
    const handlePointerMove = (event: PointerEvent) => {
      const delta = resizeStartRef.current.x - event.clientX;
      onResize(resizeStartRef.current.width + delta);
    };
    const stopResizing = () => setIsResizing(false);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResizing, { once: true });
    window.addEventListener('pointercancel', stopResizing, { once: true });
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResizing);
      window.removeEventListener('pointercancel', stopResizing);
    };
  }, [isResizing, onResize]);

  return (
    <section
      data-workspace-host="fourth-column"
      data-workspace-focused={focusedHostId === 'fourth-column' ? '' : undefined}
      aria-label="第四列辅助工作区"
      onPointerDown={() => focusHost('fourth-column')}
      className={'relative flex h-full min-w-0 shrink-0 flex-col border-l border-[var(--divider)] bg-[var(--document-bg)]'}
      style={{ width }}
    >
      <div
        role="separator"
        aria-label="调整第四列宽度"
        aria-orientation="vertical"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          resizeStartRef.current = { x: event.clientX, width };
          setIsResizing(true);
        }}
        className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize"
      />
      <FourthColumnHeader
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={selectTab}
        onCloseTab={closeTab}
        onReorderTab={reorderTab}
      />
      <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
        {activeTab ? (
          <FourthColumnTabContent
            key={activeTab.id}
            tab={activeTab}
            readOnly={Boolean(activeMemoHasDuplicateTab || activeMemoIsOpenInMain)}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-8 text-center text-sm text-[var(--muted-foreground)]">
            双击笔记，或从 Agent 产物中打开内容
          </div>
        )}
      </div>
    </section>
  );
}
