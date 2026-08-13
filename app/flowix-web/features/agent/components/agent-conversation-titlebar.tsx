'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { ArrowUpRightIcon } from '@phosphor-icons/react';

import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import { useDocumentStore } from '@features/document';
import { openNoteByMemoId } from '@features/memo/use-cases/open-by-target';
import { isWindowsPlatform } from '@features/shortcuts';
import { SidebarToggleIcon } from '@shared/icons/sidebar-toggle-icon';
import { Tooltip } from '@shared/ui/tooltip';

export function AgentConversationTitlebar({
  instanceId,
  isSidebarCollapsed,
  onExpandSidebar,
  onSidebarPreviewEnter,
  onSidebarPreviewLeave,
  canNavigateBack,
  canNavigateForward,
  onNavigateBack,
  onNavigateForward,
}: {
  instanceId: string;
  isSidebarCollapsed: boolean;
  onExpandSidebar: () => void;
  onSidebarPreviewEnter?: () => void;
  onSidebarPreviewLeave?: () => void;
  canNavigateBack: boolean;
  canNavigateForward: boolean;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
}) {
  const { t } = useI18n();
  const instance = useAgentSessionStore((state) => state.getInstance(instanceId));
  const source = instance?.source;
  const isWindows = isWindowsPlatform();

  const canOpenSource = Boolean(source?.memoId || source?.documentPath);
  const openSourceDocument = async () => {
    if (source?.memoId) {
      await openNoteByMemoId(source.memoId);
      return;
    }
    if (source?.documentPath) {
      await useDocumentStore.getState().openExternalDocument(source.documentPath);
    }
  };

  const navigationButtonClass =
    'flex h-8 w-8 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-35';

  return (
    <div
      data-tauri-drag-region
      className={`agent-conversation-titlebar z-[50] flex shrink-0 items-center ${
        isWindows
          ? 'h-9 pl-2 pr-[126px]'
          : `h-12 pr-5 ${isSidebarCollapsed ? 'pl-[90px]' : 'pl-0'}`
      }`}
      style={{ backgroundImage: 'linear-gradient(to bottom, var(--bg-titlebar), transparent)' }}
    >
      <div className="flex shrink-0 items-center gap-1">
        {isSidebarCollapsed && (
          <button
            type="button"
            onClick={onExpandSidebar}
            onMouseEnter={onSidebarPreviewEnter}
            onMouseLeave={onSidebarPreviewLeave}
            aria-label={t('document.titlebar.showSidebar')}
            title={t('document.titlebar.showSidebarTooltip')}
            className={`flex shrink-0 items-center justify-center text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] ${
              isWindows ? 'h-7 w-7 rounded-lg' : 'h-8 w-8 rounded-xl'
            }`}
          >
            <SidebarToggleIcon
              className={isWindows ? 'h-4 w-4' : 'h-5 w-5'}
              variant="collapsed"
            />
          </button>
        )}
        <Tooltip content={t('document.titlebar.backTooltip')} shortcut="history.back">
          <button
            type="button"
            onClick={onNavigateBack}
            disabled={!canNavigateBack}
            aria-label={t('document.titlebar.back')}
            className={navigationButtonClass}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        </Tooltip>
        <Tooltip content={t('document.titlebar.forwardTooltip')} shortcut="history.forward">
          <button
            type="button"
            onClick={onNavigateForward}
            disabled={!canNavigateForward}
            aria-label={t('document.titlebar.forward')}
            className={navigationButtonClass}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>

      <div data-tauri-drag-region className="ml-auto flex min-w-0 items-center">
        <Tooltip content={t('status.agent.openRun')}>
          <button
            type="button"
            disabled={!canOpenSource}
            onClick={() => void openSourceDocument().catch(() => {
              toast.error(t('status.agent.originUnavailable'));
            })}
            aria-label={t('status.agent.openRun')}
            className={`flex h-8 shrink-0 items-center justify-center gap-1.5 px-2 text-xs text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-35 ${
              isWindows
                ? 'rounded-lg'
                : 'rounded-xl border border-[var(--border)] bg-[var(--bg-titlebar)]'
            }`}
          >
            <span>{t('document.agent.viewInNote')}</span>
            <ArrowUpRightIcon className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
