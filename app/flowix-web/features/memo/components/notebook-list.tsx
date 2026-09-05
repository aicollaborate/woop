'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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
import { NotebookSelectorPopup } from '@features/shell/components/status-bar/notebook-selector-popup';

interface NotebookListProps {
  notebooks: Notebook[];
  selectedNotebook: Notebook | null;
  onSelectNotebook: (notebook: Notebook) => void;
  onEditNotebook: (notebook: Notebook) => void;
  onDeleteNotebook: (notebook: Notebook) => void;
  onCreateNotebook: () => void;
}

// 笔记本路径行 ── 纯 CSS 头部省略: 溢出时浏览器在左缘画 "…", 尾部 (笔记本名)
// 保持可见。direction:rtl 会把开头的 "/" (双向中立字符) 重排到行尾, 显得像
// 带尾部斜杠, 故文本前插 LRM (‎) 锚定为 LTR 后再整体 rtl 裁剪。
function NotebookPathLine({ path }: { path: string }) {
  const displayPath = path.trim().replace(/[\\/]+$/, '');

  return (
    <span
      className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-[11px] leading-4 text-[var(--muted-foreground)]"
      style={{ direction: 'rtl', textAlign: 'left', textOverflow: 'ellipsis' }}
      title={displayPath}
    >
      {'‎'}
      {displayPath}
    </span>
  );
}

// 笔记本入口 ── 侧边栏仅保留当前笔记本卡片；点击卡片打开完整的笔记本切换弹窗。
export function NotebookList({
  notebooks,
  selectedNotebook,
  onSelectNotebook,
  onEditNotebook,
  onDeleteNotebook,
  onCreateNotebook,
}: NotebookListProps) {
  const { t } = useI18n();
  const experimental = useExperimentalMode();
  const setNotebooks = useMemoStore((s) => s.setNotebooks);
  const notebooksInitialized = useMemoStore((s) => s.notebooksInitialized);
  const [notebookPopupOpen, setNotebookPopupOpen] = useState(false);
  const cloudStateRequestRef = useRef(0);

  const [cloudSyncedNotebookIds, setCloudSyncedNotebookIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [cloudSyncAvailable, setCloudSyncAvailable] = useState(false);
  const [cloudSyncStatuses, setCloudSyncStatuses] = useState<Map<string, CloudSyncStatus>>(
    () => new Map(),
  );

  const refreshCloudSyncedNotebookIds = useCallback(() => {
    if (!experimental) {
      setCloudSyncAvailable(false);
      setCloudSyncedNotebookIds(new Set());
      return;
    }
    const requestId = ++cloudStateRequestRef.current;
    void Promise.all([cloud.getState(), cloud.listNotebookStates()])
      .then(([cloudState, links]) => {
        if (requestId !== cloudStateRequestRef.current) return;
        setCloudSyncAvailable(cloudState.authenticated && cloudState.enabled);
        setCloudSyncedNotebookIds(
          new Set(links.filter((link) => link.enabled).map((link) => link.notebookId)),
        );
      })
      .catch(() => {
        if (requestId !== cloudStateRequestRef.current) return;
        setCloudSyncAvailable(false);
        setCloudSyncedNotebookIds(new Set());
      });
  }, [experimental]);

  useEffect(() => {
    refreshCloudSyncedNotebookIds();
  }, [notebooks, refreshCloudSyncedNotebookIds]);

  useEffect(() => {
    if (!experimental) return;
    return listenToCloudStateChanges((cloudState) => {
      setCloudSyncAvailable(cloudState.authenticated && cloudState.enabled);
      refreshCloudSyncedNotebookIds();
    });
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
          {!notebooksInitialized ? (
            <div
              className="h-12 w-full animate-pulse rounded-lg bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)]"
              aria-label={t('memo.navigation.loading')}
            />
          ) : notebooks.length === 0 ? (
            <button
              type="button"
              onClick={onCreateNotebook}
              className="flex h-12 w-full items-center rounded-lg px-2 text-left text-sm text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
            >
              {t('status.newNotebook')}
            </button>
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
                  onCreateNotebook={onCreateNotebook}
                  onRefresh={setNotebooks}
                  cloudSyncedNotebookIds={cloudSyncedNotebookIds}
                  cloudSyncAvailable={cloudSyncAvailable}
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
                      <div className="flex min-w-0 max-w-full items-center gap-0">
                        {isCloudSynced && (
                          <span
                            className="flex h-4 w-3 shrink-0 items-center justify-center"
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
                            <span
                              className={cn(
                                'h-2 w-2 rounded-full',
                                cloudSyncAvailable
                                  ? 'bg-[var(--success)]'
                                  : 'bg-[var(--muted-foreground)]',
                              )}
                              aria-hidden="true"
                            />
                          </span>
                        )}
                        <NotebookPathLine path={notebook.path} />

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
