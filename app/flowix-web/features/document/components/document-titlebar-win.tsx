'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { SidebarToggleIcon } from '@shared/icons/sidebar-toggle-icon';
import { Tooltip } from '@shared/ui/tooltip';
import {
  type DocumentTitlebarProps,
  type DocumentState,
  ExternalTitlebarBadge,
  MemoActions,
} from '@features/document/components/document-titlebar-shared';
import { useI18n } from '@/lib/i18n';

const ICON_BTN =
  'w-8 h-8 flex enabled:!cursor-pointer disabled:!cursor-not-allowed items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] rounded-lg transition-colors';

export function DocumentTitlebarWin({
  document: { currentMemo, externalFilePath = null },
  sidebar: {
    hidden: isSidebarHidden,
    onToggle: onToggleSidebar,
    onPreviewTriggerEnter,
    onPreviewTriggerLeave,
  },
  navigation: {
    canNavigateBack,
    canNavigateForward,
    onNavigateBack,
    onNavigateForward,
    visible: showNavigationButtons = true,
  },
  actions: {
    onOpenSearch,
    onCopyLink,
    onCopyFullText,
    onOpenProperties,
    onTogglePin,
    onExportMarkdown,
    onSaveAsTemplate,
    onExportWord,
    onRequestDeleteMemo,
    onColorsChange,
  },
  windowTabs,
}: DocumentTitlebarProps) {
  const { t } = useI18n();
  const documentState: DocumentState = currentMemo
    ? 'memo'
    : externalFilePath
      ? 'external'
      : 'empty';

  return (
    <div
      data-tauri-drag-region
      data-tab-window-header={windowTabs ? '' : undefined}
      className="h-9 shrink-0 pl-2 z-[50] flex items-center pr-[126px]"
      style={{ backgroundImage: 'linear-gradient(to bottom, var(--bg-titlebar), transparent)' }}
    >
      <div className="flex shrink-0 items-center gap-1">
        {isSidebarHidden && (
          <button
            type="button"
            onClick={onToggleSidebar}
            onMouseEnter={onPreviewTriggerEnter}
            onMouseLeave={onPreviewTriggerLeave}
            aria-label={t("document.titlebar.showSidebar")}
            title={t("document.titlebar.showSidebarTooltip")}
            className="w-7 h-7 flex items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] rounded-lg transition-[opacity,transform,color] duration-[400ms] animate-in fade-in zoom-in-95"
          >
            <SidebarToggleIcon className="w-4 h-4" variant="collapsed" />
          </button>
        )}
        {showNavigationButtons && (
          <>
            <Tooltip content={t("document.titlebar.backTooltip")} shortcut="history.back">
              <button
                type="button"
                onClick={onNavigateBack}
                disabled={!canNavigateBack}
                aria-label={t("document.titlebar.back")}
                className={`${ICON_BTN} disabled:opacity-35`}
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
            </Tooltip>
            <Tooltip content={t("document.titlebar.forwardTooltip")} shortcut="history.forward">
              <button
                type="button"
                onClick={onNavigateForward}
                disabled={!canNavigateForward}
                aria-label={t("document.titlebar.forward")}
                className={`${ICON_BTN} disabled:opacity-35`}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </Tooltip>
          </>
        )}
      </div>

      {windowTabs && (
        <div className="mr-1 flex h-8 min-w-0 flex-1" data-tauri-drag-region>
          {windowTabs}
        </div>
      )}


      <div
        data-tauri-drag-region
        className={`${windowTabs ? '' : 'ml-auto'} flex shrink-0 items-center gap-2 pr-5`}
      >
        {documentState === 'external' && (
          <ExternalTitlebarBadge />
        )}
        {documentState === 'memo' && currentMemo && (
          <MemoActions
            memo={currentMemo}
            iconButtonClass={ICON_BTN}
            onOpenSearch={onOpenSearch}
            onCopyLink={onCopyLink}
            onCopyFullText={onCopyFullText}
            onOpenProperties={onOpenProperties}
            onTogglePin={onTogglePin}
            onExportMarkdown={onExportMarkdown}
            onSaveAsTemplate={onSaveAsTemplate}
            onExportWord={onExportWord}
            onRequestDeleteMemo={onRequestDeleteMemo}
            onColorsChange={onColorsChange ?? (() => {})}
          />
        )}
      </div>
    </div>
  );
}
