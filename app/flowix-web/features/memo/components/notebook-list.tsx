'use client';

import { useCallback, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { OverlayScrollbar } from '@shared/ui/overlay-scrollbar';
import { NotebookIcon, useMemoStore, type Notebook } from '@features/memo';
import { useI18n } from '@/lib/i18n';
import {
  cloud,
  listenToCloudStateChanges,
  listenToCloudSyncStatusChanges,
  type CloudSyncStatus,
} from '@platform/tauri/client';
import { useExperimentalMode } from '@platform/tauri/use-experimental-mode';
import { cloudSyncErrorMessage } from '@platform/tauri/errors';
import { CloudStatusIcon } from '@shared/icons/cloud-status-icon';
import { NotebookSelectorPopup } from '@features/shell/components/status-bar/notebook-selector-popup';

interface NotebookListProps {
  notebooks: Notebook[];
  selectedNotebook: Notebook | null;
  onSelectNotebook: (notebook: Notebook) => void;
  onEditNotebook: (notebook: Notebook) => void;
  onDeleteNotebook: (notebook: Notebook) => void;
}

// 笔记本入口 ── 侧边栏仅保留当前笔记本卡片；点击卡片打开完整的笔记本切换弹窗。
export function NotebookList({
  notebooks,
  selectedNotebook,
  onSelectNotebook,
  onEditNotebook,
  onDeleteNotebook,
}: NotebookListProps) {
  const { t } = useI18n();
  const experimental = useExperimentalMode();
  const setNotebooks = useMemoStore((s) => s.setNotebooks);
  const [notebookPopupOpen, setNotebookPopupOpen] = useState(false);

  const [cloudSyncedNotebookIds, setCloudSyncedNotebookIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [cloudSyncStatuses, setCloudSyncStatuses] = useState<Map<string, CloudSyncStatus>>(
    () => new Map(),
  );

  const refreshCloudSyncedNotebookIds = useCallback(() => {
    if (!experimental) {
      setCloudSyncedNotebookIds(new Set());
      return;
    }
    void cloud.listNotebookStates()
      .then((links) => {
        setCloudSyncedNotebookIds(
          new Set(links.filter((link) => link.enabled).map((link) => link.notebookId)),
        );
      })
      .catch(() => {
        setCloudSyncedNotebookIds(new Set());
      });
  }, [experimental]);

  useEffect(() => {
    refreshCloudSyncedNotebookIds();
  }, [notebooks, refreshCloudSyncedNotebookIds]);

  useEffect(() => {
    if (!experimental) return;
    return listenToCloudStateChanges(refreshCloudSyncedNotebookIds);
  }, [experimental, refreshCloudSyncedNotebookIds]);

  useEffect(() => {
    if (!experimental) return;
    return listenToCloudSyncStatusChanges((status) => {
      setCloudSyncStatuses((previous) => {
        const current = previous.get(status.notebookId);
        if (current && status.startedAt < current.startedAt) {
          return previous;
        }
        const next = new Map(previous);
        next.set(status.notebookId, status);
        return next;
      });
    });
  }, [experimental]);

  useEffect(() => {
    if (!experimental || cloudSyncedNotebookIds.size === 0) return;
    const syncAfterConnectivityReturns = () => {
      void cloud.syncNow().catch(() => {
        // The native sync status event owns user-visible error reporting.
      });
    };
    const syncAfterForeground = () => {
      if (document.visibilityState === 'visible') syncAfterConnectivityReturns();
    };
    window.addEventListener('online', syncAfterConnectivityReturns);
    document.addEventListener('visibilitychange', syncAfterForeground);
    return () => {
      window.removeEventListener('online', syncAfterConnectivityReturns);
      document.removeEventListener('visibilitychange', syncAfterForeground);
    };
  }, [cloudSyncedNotebookIds, experimental]);

  return (
    <div className="flex min-h-0 max-h-[52px] shrink-0 flex-col">
      <OverlayScrollbar
        className="min-h-0 flex-1 overflow-hidden"
        scrollerClassName="h-full overflow-y-auto px-2"
      >
        <div className="space-y-0.5 pb-1">
          {notebooks.length === 0 ? (
            <div className="px-2 py-2 text-sm text-[var(--muted-foreground)]">
              {t('status.noNotebooks')}
            </div>
          ) : (
            notebooks.map((notebook) => {
              if (notebook.id !== selectedNotebook?.id) return null;
              const isActive = selectedNotebook?.id === notebook.id;
              const isCloudSynced = cloudSyncedNotebookIds.has(notebook.id);
              const isMissing = Boolean(notebook.missing);
              const cloudSyncStatus = cloudSyncStatuses.get(notebook.id);
              const cloudSyncInProgress =
                cloudSyncStatus?.state === 'queued' ||
                cloudSyncStatus?.state === 'checking' ||
                cloudSyncStatus?.state === 'syncing' ||
                cloudSyncStatus?.state === 'finalizing';
              return (
                <NotebookSelectorPopup
                  key={notebook.id}
                  open={notebookPopupOpen}
                  onOpenChange={setNotebookPopupOpen}
                  notebooks={notebooks}
                  selectedNotebook={selectedNotebook}
                  onSelect={onSelectNotebook}
                  onEdit={onEditNotebook}
                  onDelete={onDeleteNotebook}
                  onRefresh={setNotebooks}
                  side="bottom"
                  trigger={
                    <div
                      role="button"
                      tabIndex={0}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setNotebookPopupOpen((open) => !open);
                        }
                      }}
                      className={cn(
                        'group relative flex h-12 w-full cursor-pointer select-none items-start gap-2 overflow-hidden rounded-lg py-1 pl-1.5 pr-3 text-left text-sm text-[var(--foreground)] transition-colors',
                        'ring-1 ring-inset ring-[color-mix(in_oklch,var(--foreground)_7%,transparent)]',
                        isMissing && 'opacity-70',
                      )}
                      style={{
                        backgroundColor: 'var(--agent-bg)',
                        backgroundImage:
                          'radial-gradient(ellipse 90% 145% at 100% 0%, color-mix(in oklch, var(--primary) 18%, transparent), transparent 58%)',
                      }}
                      title={notebook.name}
                      aria-pressed={notebookPopupOpen}
                    >
                  <NotebookIcon
                    icon={notebook.icon}
                    name={notebook.name}
                    className="h-6 w-6 rounded-md bg-[var(--muted)] text-[11px] font-semibold text-[var(--secondary-foreground)]"
                    imageClassName="h-[72%] w-[72%]"
                  />
                  <div
                    className={cn(
                      'min-w-0 flex-1',
                      isActive
                        ? 'flex flex-col justify-start gap-0'
                        : 'flex items-center gap-1.5',
                    )}
                  >
                    <span className="min-w-0 truncate leading-6">
                      <span className={isMissing ? 'text-[var(--muted-foreground)]' : ''}>
                        {notebook.name}
                      </span>
                      {isMissing && (
                        <>
                          <span className="text-[var(--muted-foreground)]">{' '}</span>
                          <span className="text-[var(--muted-foreground)]">
                            {t('status.invalid')}
                          </span>
                        </>
                      )}
                    </span>
                    {isActive && (
                      <div className="flex min-w-0 max-w-full items-center gap-1">
                        {isCloudSynced && (
                          <span
                            className="flex h-4 w-4 shrink-0 items-center justify-center"
                            title={
                              cloudSyncStatus?.lastError
                                ? cloudSyncErrorMessage(cloudSyncStatus.lastError, t)
                                : cloudSyncInProgress
                                  ? t('notebook.cloudSync.syncing')
                                  : cloudSyncStatus?.state === 'success'
                                    ? t('notebook.cloudSync.complete')
                                    : t('notebook.cloudSync.title')
                            }
                          >
                            {cloudSyncInProgress ? (
                              <CloudStatusIcon
                                status="connecting"
                                size={12}
                                className="text-[var(--secondary-foreground)]"
                              />
                            ) : cloudSyncStatus?.state === 'error' ? (
                              <CloudStatusIcon
                                status="unlinked"
                                size={12}
                                className="text-[var(--destructive)]"
                              />
                            ) : (
                              <CloudStatusIcon
                                status="connected"
                                size={12}
                                className="text-[var(--secondary-foreground)]"
                              />
                            )}
                          </span>
                        )}
                        <span
                          className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-[11px] leading-4 text-[var(--muted-foreground)]"
                          style={{ direction: 'rtl', textAlign: 'left', textOverflow: 'clip' }}
                          title={notebook.path}
                        >
                          {notebook.path.trim().replace(/[\\/]+$/, '')}
                        </span>
                      </div>
                    )}
                    </div>
                    </div>
                  }
                />
              );
            })
          )}
        </div>
      </OverlayScrollbar>
    </div>
  );
}
