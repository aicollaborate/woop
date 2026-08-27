'use client';

import { useCallback, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react';
import { FileTextIcon, TrashSimpleIcon } from '@phosphor-icons/react';

import { useI18n } from '@/lib/i18n';
import { isWindowsPlatform } from '@features/shortcuts';
import { SidebarToggleIcon } from '@shared/icons/sidebar-toggle-icon';
import { Tooltip } from '@shared/ui/tooltip';
import {
  DOCUMENT_TITLEBAR_ICON_BUTTON_MAC,
  DOCUMENT_TITLEBAR_ICON_BUTTON_WIN,
} from '@features/document/components/document-titlebar-shared';
import { DEFAULT_AGENT_TYPE_KEY, getAgentType } from '@/lib/agent-types';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import { useDocumentStore } from '@features/document';
import { clearRestoredAgentConversation } from '@features/workspace/use-cases/agent-conversation-navigation';
import { openNoteByMemoId } from '@features/memo/use-cases/open-by-target';
import { getAgentConversationPresentation } from '@features/agent/conversation-presentation';
import { AgentIcon } from '@features/agent/components/agent-icon';
import { BadgeHoverCard } from '@features/agent/thread-card/badge-hover-card';
import { computeAgentThreadCardBadgeData } from '@features/agent/thread-card/runtime/run-status-presenter';
import { deepseekHarness } from '@platform/tauri/client';
import { toast } from '@/lib/toast';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';

function AgentConversationHeader({ instanceId }: { instanceId: string }) {
  const { t } = useI18n();
  const isWindows = isWindowsPlatform();
  const instance = useAgentSessionStore((state) => state.getInstance(instanceId));
  const projection = useAgentSessionStore((state) => {
    const threadId = state.getInstance(instanceId)?.threadId;
    return threadId ? state.threadProjections[threadId] : undefined;
  });
  const codexModel = useAgentSessionStore((state) => state.sessionMeta.settings.agentCodexModel);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  const badgeData = useMemo(() => computeAgentThreadCardBadgeData({
    threadState: projection ? {
      lastRun: projection.runs.lastRun,
      activeRunId: projection.runs.activeRunId,
      runs: projection.runs.runs,
    } : undefined,
    codexModel,
    typeKey: instance?.agentType ?? DEFAULT_AGENT_TYPE_KEY,
  }), [codexModel, instance?.agentType, projection]);

  if (!instance) return null;
  const agent = getAgentType(instance.agentType);
  const presentation = getAgentConversationPresentation(instance, t('common.untitled'));
  const { source, runtimeCwd, hasSourceDocument } = presentation;
  const actionButtonClass = isWindows
    ? DOCUMENT_TITLEBAR_ICON_BUTTON_WIN
    : DOCUMENT_TITLEBAR_ICON_BUTTON_MAC;

  const handleOpenSourceDocument = () => {
    if (!hasSourceDocument) return;
    const open = source?.memoId
      ? openNoteByMemoId(source.memoId)
      : source?.documentPath
        ? useDocumentStore.getState().openExternalDocument(source.documentPath)
        : Promise.resolve();
    void open.catch(() => toast.error(t('status.agent.originUnavailable')));
  };
  const handleDeleteConversation = useCallback(() => {
    useAgentSessionStore.getState().removeInstance(instance.instanceId);
    clearRestoredAgentConversation(instance.instanceId);
    if (useDocumentStore.getState().activeAgentConversationId === instance.instanceId) {
      useDocumentStore.getState().closeAgentConversation();
    }
  }, [instance.instanceId]);
  const commitTitle = () => {
    const title = titleDraft.trim();
    if (title) void useAgentSessionStore.getState().renameAgentConversation({
      instanceId: instance.instanceId,
      threadId: instance.threadId,
      title,
      typeKey: instance.agentType,
    });
    setIsEditingTitle(false);
  };

  return (
    <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2">
      <span className="agent-thread-card__badge-hover-wrapper shrink-0">
        <BadgeHoverCard
          sessionId={instance.threadId ?? ''}
          model={badgeData.model}
          usage={badgeData.usage}
          onRequestRuntimeInfo={instance.agentType === 'deepseek-harness' && instance.threadId
            ? () => deepseekHarness.sessionUsage(instance.threadId!)
            : undefined}
          cwd={runtimeCwd}
        />
        <span className="agent-type-badge" aria-hidden="true" title={agent.desc}>
          <AgentIcon typeKey={agent.key} alt="" className="agent-type-badge__icon" />
        </span>
      </span>
      {isEditingTitle ? (
        <div className="min-w-0 flex-1 truncate text-sm font-semibold leading-none text-[var(--foreground)] [-webkit-app-region:no-drag]">
          <input autoFocus value={titleDraft}
            className="agent-thread-card__title-input h-[1em] w-full min-w-0 border-0 bg-transparent p-0 font-inherit leading-none text-[var(--foreground)] shadow-none outline-none ring-0 focus:border-0 focus:bg-transparent focus:outline-none focus:ring-0 [-webkit-app-region:no-drag]"
            onChange={(event) => setTitleDraft(event.target.value)} onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === 'Enter') { event.preventDefault(); commitTitle(); }
              if (event.key === 'Escape') setIsEditingTitle(false);
            }} />
        </div>
      ) : (
        <div className="min-w-0 flex-[0_1_auto] truncate text-sm font-semibold leading-none text-[var(--foreground)]" onDoubleClick={() => {
          setTitleDraft(instance.title?.trim() || '');
          setIsEditingTitle(true);
        }}>{presentation.title}</div>
      )}
      <div className={`ml-auto flex shrink-0 items-center ${isWindows ? 'gap-2 pr-4' : 'gap-3 pr-4'}`}>
        {hasSourceDocument ? <>
            <button type="button" onClick={handleOpenSourceDocument} aria-label={t('document.agent.viewInNote')}
              title={t('document.agent.viewInNote')} className={`${actionButtonClass} [-webkit-app-region:no-drag]`}>
              <FileTextIcon className="h-4 w-4" />
            </button>
          </> : (
            <span className="agent-thread-card__no-source text-[0.8125rem] leading-none text-[var(--muted-foreground)]" aria-label={t('document.agent.noSourceNote')}>
              {t('document.agent.noSourceNote')}
            </span>
          )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label={t('document.agent.moreActions')} title={t('document.agent.moreActions')}
              className={`${actionButtonClass} [-webkit-app-region:no-drag]`}>
              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[216px] space-y-0.5 px-1 py-1.5">
            <DropdownMenuItem onClick={handleDeleteConversation}
              className="justify-start gap-2 rounded-md px-2 py-1.5 text-left text-[var(--destructive)] hover:bg-[var(--muted)] hover:text-[var(--destructive)]">
              <TrashSimpleIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{t('document.agent.deleteConversation')}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

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
  const isWindows = isWindowsPlatform();

  const navigationButtonClass =
    'flex h-8 w-8 items-center justify-center rounded-lg text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-35';

  return (
    <div
      data-tauri-drag-region
      className={`agent-conversation-titlebar z-[50] flex shrink-0 select-none items-center ${
        isWindows
          ? 'h-9 pl-2 pr-[126px]'
          : `h-12 pr-0 ${isSidebarCollapsed ? 'pl-[90px]' : 'pl-0'}`
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
            className={`flex shrink-0 items-center justify-center text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] [-webkit-app-region:no-drag] ${
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
            className={`${navigationButtonClass} [-webkit-app-region:no-drag]`}
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
            className={`${navigationButtonClass} [-webkit-app-region:no-drag]`}
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>
      <div data-tauri-drag-region className="min-w-0 flex-1">
        <AgentConversationHeader instanceId={instanceId} />
      </div>
    </div>
  );
}
