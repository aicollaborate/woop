import { useState, type DragEvent, type KeyboardEvent } from 'react';
import { Check, ChevronDown, FileText, MessageSquare, X } from 'lucide-react';
import type { FourthColumnTab } from '@features/workspace/store/fourth-column-store';
import {
  AgentThreadCardFullscreenExitButton,
  useFullscreenAgentThreadCardInfo,
} from '@features/document/components/document-titlebar-shared';
import { AgentIcon } from '@features/agent/components/agent-icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useWorkspaceFocusStore } from '@features/workspace/store/workspace-focus-store';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';

function isWindowsPlatform(): boolean {
  return typeof navigator !== 'undefined'
    && (/Windows/i.test(navigator.userAgent) || /Win/i.test(navigator.platform));
}

function tabIcon(tab: FourthColumnTab) {
  if (tab.icon) return <span className="text-sm leading-none">{tab.icon}</span>;
  if (tab.target.kind === 'agent_conversation') return <MessageSquare className="h-3.5 w-3.5" />;
  return <FileText className="h-3.5 w-3.5" />;
}

export interface FourthColumnHeaderProps {
  tabs: FourthColumnTab[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onReorderTab: (tabId: string, beforeTabId: string | null) => void;
}

export function FourthColumnHeader({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onReorderTab,
}: FourthColumnHeaderProps) {
  const { t } = useI18n();
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const isWindows = isWindowsPlatform();
  const isFocused = useWorkspaceFocusStore((state) => state.focusedHostId === 'fourth-column');
  // A fullscreen Thread Card keeps its DOM position inside this column, so the
  // host-scoped info hook only fires for cards mounted in the fourth column —
  // third-column fullscreen never reaches this header.
  const fullscreenInfo = useFullscreenAgentThreadCardInfo('fourth-column');

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex = index;
    if (event.key === 'ArrowRight') nextIndex = Math.min(index + 1, tabs.length - 1);
    else if (event.key === 'ArrowLeft') nextIndex = Math.max(index - 1, 0);
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    else return;

    event.preventDefault();
    onSelectTab(tabs[nextIndex].id);
  };

  return (
    <header
      data-fourth-column-header
      data-tauri-drag-region
      data-thread-card-fullscreen={fullscreenInfo ? '' : undefined}
      className={cn(
        'relative flex shrink-0 items-center pl-1 pr-2',
        isWindows ? 'h-9 min-h-9 pr-[126px]' : 'h-12 min-h-12',
        fullscreenInfo && 'agent-thread-card-fullscreen-titlebar',
      )}
      style={fullscreenInfo ? undefined : { backgroundImage: 'linear-gradient(to bottom, var(--bg-titlebar), transparent)' }}
    >
      <div
        role="tablist"
        aria-label={t('tabWindow.openContent')}
        data-tauri-drag-region
        className="flex h-8 min-w-0 flex-1 items-center gap-0 overflow-x-auto overflow-y-hidden p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab, index) => {
          const selected = tab.id === activeTabId;
          // 仅激活 tab 会挂载内容，全屏卡片必然在其中 ── 全屏期间激活
          // tab 换成 Agent 图标 + 对话标题，退出后回退 tab 自身标题。
          const tabFullscreen = selected && fullscreenInfo
            ? { title: fullscreenInfo.title || tab.title, typeKey: fullscreenInfo.typeKey }
            : null;
          return (
            <div
              key={tab.id}
              draggable
              onDragStart={(event: DragEvent<HTMLDivElement>) => {
                if ((event.target as HTMLElement).closest('[data-tab-close]')) {
                  event.preventDefault();
                  return;
                }
                setDraggedTabId(tab.id);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', tab.id);
              }}
              onDragEnd={() => setDraggedTabId(null)}
              onDragOver={(event) => {
                if (!draggedTabId || draggedTabId === tab.id) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(event) => {
                event.preventDefault();
                const sourceTabId = draggedTabId ?? event.dataTransfer.getData('text/plain');
                if (sourceTabId && sourceTabId !== tab.id) onReorderTab(sourceTabId, tab.id);
                setDraggedTabId(null);
              }}
              className={cn(
                'group relative flex h-8 min-w-[60px] max-w-[150px] shrink basis-[150px] items-center overflow-hidden border text-xs transition-[color,background-color,border-color,opacity] [-webkit-app-region:no-drag]',
                selected && isFocused
                  ? 'rounded-t-xl border-[var(--brand)]/40 border-b-transparent bg-transparent text-[var(--foreground)]'
                  : selected
                    ? 'rounded-t-xl border-[var(--border)] border-b-transparent bg-transparent text-[var(--foreground)]'
                    : 'rounded-lg border-transparent text-[var(--muted-foreground)] hover:text-[var(--foreground)]',
                draggedTabId === tab.id && 'opacity-45',
              )}
            >
              {selected && isFocused && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[var(--brand)] to-transparent"
                />
              )}
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                title={tabFullscreen?.title ?? tab.title}
                draggable={false}
                onClick={() => onSelectTab(tab.id)}
                onKeyDown={(event) => handleKeyDown(event, index)}
                className="min-w-0 flex-1 cursor-default truncate py-2 pl-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] [-webkit-app-region:no-drag]"
              >
                {tabFullscreen ? (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <AgentIcon
                      typeKey={tabFullscreen.typeKey}
                      alt=""
                      className="h-3.5 w-3.5 shrink-0"
                    />
                    <span className="min-w-0 truncate">{tabFullscreen.title}</span>
                  </span>
                ) : (
                  tab.title
                )}
              </button>
              <button
                type="button"
                draggable={false}
                data-tab-close
                onClick={() => onCloseTab(tab.id)}
                className="mr-[0.25rem] flex h-5 w-5 shrink-0 cursor-default items-center justify-center opacity-60 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] [-webkit-app-region:no-drag]"
                aria-label={t('tabWindow.closeTab', { title: tab.title })}
                title={t('tabWindow.closeTab', { title: tab.title })}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
      {/* 全屏 Thread Card 接管本列内容区时，退出按钮落在第四列头部，
          紧邻右侧的下拉按钮左侧，与第三列 titlebar 的 exit 按钮同一组件/样式，
          仅 host 作用域不同。 */}
      <AgentThreadCardFullscreenExitButton
        host="fourth-column"
        className="agent-thread-card-fullscreen-exit-btn"
      />
      <div className="h-8 w-8 shrink-0 pr-0.5 [-webkit-app-region:no-drag]">
        <DropdownMenu className="[-webkit-app-region:no-drag]">
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('tabWindow.showAll')}
              title={t('tabWindow.showAll')}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] [-webkit-app-region:no-drag]"
            >
              <ChevronDown className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            side="bottom"
            sideOffset={4}
            className="max-h-[min(420px,calc(100vh-16px))] w-[280px] overflow-y-auto p-1"
          >
            <DropdownMenuLabel className="px-2 py-1 text-xs font-medium text-[var(--muted-foreground)]">
              {t('tabWindow.all')}
            </DropdownMenuLabel>
            <div className="space-y-0.5">
              {tabs.map((tab) => {
                const selected = tab.id === activeTabId;
                return (
                  <DropdownMenuItem
                    key={tab.id}
                    title={tab.title}
                    onClick={() => onSelectTab(tab.id)}
                    className="gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--muted)]"
                  >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--muted-foreground)]">
                      {tabIcon(tab)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-left">{tab.title}</span>
                    {selected && <Check className="h-3.5 w-3.5 shrink-0 text-[var(--brand)]" />}
                  </DropdownMenuItem>
                );
              })}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
