import { ChevronRight, Hash, Layers3, LogOut, MoreHorizontal, Pencil, Plus } from 'lucide-react';
import { TrashSimpleIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type FormEvent, type TouchEvent } from 'react';

import type { MobileTag } from './mobile-model';
import { NotebookIcon } from '@features/memo/components/notebook-icon';
import { mobileClient, type CloudState, type NotebookRecord } from '@platform/tauri/mobile-client';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';

interface MobileNavigationDrawerProps {
  cloudState: CloudState | null;
  notebooks: NotebookRecord[];
  selectedNotebookId: string | null;
  selectedTagId: string | null;
  tags: MobileTag[];
  onAccount: () => void;
  onClose: () => void;
  onLogout: () => void;
  onSelectNotebook: (id: string) => void;
  onSelectTag: (id: string | null) => void;
  onCreateNotebook: (name: string) => Promise<NotebookRecord | null>;
  onDeleteNotebook: (id: string) => Promise<boolean>;
  onRenameNotebook: (id: string, name: string) => Promise<boolean>;
}

function formatStorage(value: number | null | undefined): string {
  if (!value || value < 0) return '0MB';
  const megabytes = value / (1024 * 1024);
  if (megabytes < 10) return `${megabytes.toFixed(1)} MB`;
  return `${Math.round(megabytes)} MB`;
}

function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const userAgent = navigator.userAgent.toLowerCase();
  return /iphone|ipad|ipod/.test(userAgent)
    || (userAgent.includes('macintosh') && navigator.maxTouchPoints > 0);
}

export function MobileNavigationDrawer({
  cloudState,
  notebooks,
  selectedNotebookId,
  selectedTagId,
  tags,
  onAccount,
  onClose,
  onLogout,
  onSelectNotebook,
  onSelectTag,
  onCreateNotebook,
  onDeleteNotebook,
  onRenameNotebook,
}: MobileNavigationDrawerProps) {
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const nativeOffsetFrameRef = useRef<number | null>(null);
  const nativeOffsetRef = useRef(0);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const [editingNotebook, setEditingNotebook] = useState<NotebookRecord | null>(null);
  const [notebookToDelete, setNotebookToDelete] = useState<NotebookRecord | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [notebookName, setNotebookName] = useState('');
  const [savingNotebook, setSavingNotebook] = useState(false);
  const [nativeNotebookActionsUnavailable, setNativeNotebookActionsUnavailable] = useState(false);
  const [nativeNotebookButtonsReady, setNativeNotebookButtonsReady] = useState(false);
  const drawerRef = useRef<HTMLElement | null>(null);

  const openCreateNotebook = () => {
    setNotebookName('');
    setEditingNotebook(null);
  };

  const openRenameNotebook = (notebook: NotebookRecord) => {
    setNotebookName(notebook.name);
    setEditingNotebook(notebook);
  };

  const closeNotebookDialog = () => {
    setNotebookName('');
    setEditingNotebook(null);
  };

  const [notebookDialogOpen, setNotebookDialogOpen] = useState(false);
  const showCreateNotebook = () => {
    openCreateNotebook();
    setNotebookDialogOpen(true);
  };
  const showRenameNotebook = (notebook: NotebookRecord) => {
    openRenameNotebook(notebook);
    setNotebookDialogOpen(true);
  };
  const dismissNotebookDialog = () => {
    setNotebookDialogOpen(false);
    closeNotebookDialog();
  };
  const submitNotebook = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = notebookName.trim();
    if (!name || savingNotebook) return;
    setSavingNotebook(true);
    try {
      if (editingNotebook) {
        if (await onRenameNotebook(editingNotebook.id, name)) dismissNotebookDialog();
      } else {
        const created = await onCreateNotebook(name);
        if (created) {
          onSelectNotebook(created.id);
          dismissNotebookDialog();
        }
      }
    } finally {
      setSavingNotebook(false);
    }
  };

  const confirmDeleteNotebook = async () => {
    if (!notebookToDelete || savingNotebook || deleteError) return;
    setSavingNotebook(true);
    try {
      if (await onDeleteNotebook(notebookToDelete.id)) setNotebookToDelete(null);
      else setDeleteError('删除失败，请稍后重试。');
    } finally {
      setSavingNotebook(false);
    }
  };

  const requestDeleteNotebook = (notebook: NotebookRecord) => {
    setDeleteError(notebooks.length <= 1 ? '至少保留一个笔记本，不能删除。' : '');
    setNotebookToDelete(notebook);
  };

  const handleNotebookMore = async (notebook: NotebookRecord) => {
    if (!isIOSDevice()) return;
    try {
      await mobileClient.showNotebookActions(notebook.id, notebook.name);
    } catch {
      // Allow an older native shell or an unavailable presentation host to
      // fall back to the existing web menu on the next tap.
      setNativeNotebookActionsUnavailable(true);
    }
  };

  const scheduleNativeNotebookActionOffset = (offset: number) => {
    if (!isIOSDevice()) return;
    nativeOffsetRef.current = offset;
    if (nativeOffsetFrameRef.current !== null) return;
    nativeOffsetFrameRef.current = window.requestAnimationFrame(() => {
      nativeOffsetFrameRef.current = null;
      void mobileClient.setNotebookActionButtonsOffset(nativeOffsetRef.current).catch(() => undefined);
    });
  };

  useEffect(() => () => {
    if (nativeOffsetFrameRef.current !== null) {
      window.cancelAnimationFrame(nativeOffsetFrameRef.current);
    }
  }, []);

  useEffect(() => {
    if (!isIOSDevice()) return;

    if (notebookDialogOpen || notebookToDelete || nativeNotebookActionsUnavailable) {
      setNativeNotebookButtonsReady(false);
      void mobileClient.syncNotebookActionButtons([]).catch(() => undefined);
      return;
    }

    const syncNativeButtons = () => {
      const buttons = Array.from(
        drawerRef.current?.querySelectorAll<HTMLElement>('.mobile-notebook-more') ?? [],
      ).map((button) => {
        const notebookId = button.dataset.notebookId;
        const notebook = notebooks.find((item) => item.id === notebookId);
        if (!notebook) return null;
        const rect = button.getBoundingClientRect();
        return {
          id: notebook.id,
          name: notebook.name,
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        };
      }).filter((button): button is NonNullable<typeof button> => button !== null);

      void mobileClient.syncNotebookActionButtons(buttons)
        .then(() => setNativeNotebookButtonsReady(buttons.length > 0))
        .catch(() => setNativeNotebookButtonsReady(false));
    };

    const frame = window.requestAnimationFrame(syncNativeButtons);
    const animationTimer = window.setTimeout(syncNativeButtons, 260);
    const content = drawerRef.current?.querySelector('.mobile-drawer-content');
    content?.addEventListener('scroll', syncNativeButtons, { passive: true });
    window.addEventListener('resize', syncNativeButtons);
    window.visualViewport?.addEventListener('resize', syncNativeButtons);
    window.visualViewport?.addEventListener('scroll', syncNativeButtons);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(animationTimer);
      content?.removeEventListener('scroll', syncNativeButtons);
      window.removeEventListener('resize', syncNativeButtons);
      window.visualViewport?.removeEventListener('resize', syncNativeButtons);
      window.visualViewport?.removeEventListener('scroll', syncNativeButtons);
      void mobileClient.syncNotebookActionButtons([]).catch(() => undefined);
    };
  }, [nativeNotebookActionsUnavailable, notebookDialogOpen, notebookToDelete, notebooks]);

  useEffect(() => {
    const handleNativeNotebookAction = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; action?: string }>).detail;
      const notebook = detail?.id ? notebooks.find((item) => item.id === detail.id) : null;
      if (!notebook) return;
      setNativeNotebookButtonsReady(false);
      void mobileClient.syncNotebookActionButtons([]).catch(() => undefined);
      if (detail.action === 'edit') showRenameNotebook(notebook);
      if (detail.action === 'delete') requestDeleteNotebook(notebook);
    };
    window.addEventListener('flowix-native-notebook-action', handleNativeNotebookAction);
    return () => window.removeEventListener('flowix-native-notebook-action', handleNativeNotebookAction);
  }, [notebooks]);

  const openAccountPanel = () => {
    setNativeNotebookButtonsReady(false);
    void mobileClient.syncNotebookActionButtons([]).catch(() => undefined);
    onAccount();
  };

  const handleTouchStart = (event: TouchEvent<HTMLElement>) => {
    const touch = event.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    setIsSwiping(false);
    scheduleNativeNotebookActionOffset(0);
  };

  const handleTouchMove = (event: TouchEvent<HTMLElement>) => {
    const start = touchStartRef.current;
    if (!start) return;
    const touch = event.touches[0];
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (!isSwiping && Math.abs(dy) > Math.abs(dx)) return;
    if (dx < 0) {
      setIsSwiping(true);
      setSwipeOffset(dx);
      scheduleNativeNotebookActionOffset(dx);
    }
  };

  const handleTouchEnd = () => {
    if (swipeOffset < -64) onClose();
    scheduleNativeNotebookActionOffset(0);
    touchStartRef.current = null;
    setSwipeOffset(0);
    setIsSwiping(false);
  };

  const accountName = cloudState?.account?.user.displayName?.trim()
    || cloudState?.account?.user.email
    || 'Flowix 账号';
  const accountSubtitle = cloudState?.authenticated
    ? `${formatStorage(cloudState.membership?.usedBytes)} / ${formatStorage(cloudState.membership?.quotaBytes)}`
    : '点击登录并云同步';

  return (
    <div
      className="mobile-drawer-layer"
      role="presentation"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      <button type="button" className="mobile-drawer-backdrop" aria-label="关闭导航" onClick={onClose} />
      <aside
        ref={drawerRef}
        className="mobile-drawer"
        aria-label="笔记导航"
        style={{
          transform: swipeOffset ? `translateX(${swipeOffset}px)` : undefined,
          transition: isSwiping ? 'none' : undefined,
        }}
      >
        <div className="mobile-drawer-header">
          <div className="mobile-drawer-account">
            <button
              type="button"
              aria-label={cloudState?.authenticated ? `账号：${accountName}，${accountSubtitle}` : '未登录，点击登录并云同步'}
              onClick={openAccountPanel}
            >
              <span>
                <strong>{cloudState?.authenticated ? accountName : '未登录'}</strong>
                <small>{accountSubtitle}</small>
              </span>
            </button>
            {cloudState?.account && (
              <button type="button" className="mobile-logout-button mobile-drawer-close-button" aria-label="退出登录" onClick={onLogout}>
                <LogOut size={17} aria-hidden="true" />
              </button>
            )}
          </div>
          <button type="button" className="mobile-icon-button mobile-drawer-close-button" aria-label="关闭导航" onClick={onClose}><ChevronRight size={20} /></button>
        </div>

        <nav className="mobile-drawer-content">
          <section>
            <div className="mobile-drawer-section-title">
              <h2>笔记本</h2>
              <button type="button" className="mobile-drawer-add" aria-label="新建笔记本" onClick={showCreateNotebook}><Plus size={18} /></button>
            </div>
            <div className="mobile-notebook-grid">
              {notebooks.map((notebook) => (
                <div
                  key={notebook.id}
                  className={`mobile-notebook-card${notebook.id === selectedNotebookId ? ' is-selected' : ''}`}
                >
                  <button type="button" className="mobile-notebook-select" onClick={() => onSelectNotebook(notebook.id)}>
                    <span className="mobile-notebook-card__topline">
                      <NotebookIcon icon={notebook.icon} name={notebook.name} className="mobile-notebook-icon" />
                    </span>
                    <span className="mobile-notebook-card__details">
                      <span className="mobile-notebook-card__name">{notebook.name}</span>
                      <span className="mobile-notebook-card__count">{notebook.memoCount ?? 0} 篇</span>
                    </span>
                  </button>
                  {isIOSDevice() && !nativeNotebookActionsUnavailable ? (
                  <button
                    type="button"
                    data-notebook-id={notebook.id}
                    className={`mobile-notebook-more${nativeNotebookButtonsReady ? ' mobile-notebook-more--native' : ''}`}
                    aria-label={`更多${notebook.name}操作`}
                    aria-hidden={nativeNotebookButtonsReady}
                    tabIndex={nativeNotebookButtonsReady ? -1 : 0}
                    disabled={savingNotebook}
                    onClick={nativeNotebookButtonsReady ? undefined : () => void handleNotebookMore(notebook)}
                  >
                    <MoreHorizontal size={18} aria-hidden="true" />
                  </button>
                ) : (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        data-notebook-id={notebook.id}
                        className="mobile-notebook-more"
                        aria-label={`更多${notebook.name}操作`}
                        disabled={savingNotebook}
                      >
                        <MoreHorizontal size={18} aria-hidden="true" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" side="bottom" sideOffset={4} className="mobile-notebook-menu">
                      <DropdownMenuItem className="mobile-notebook-menu__item" onClick={() => showRenameNotebook(notebook)}>
                        <Pencil size={15} aria-hidden="true" />
                        <span>编辑笔记本</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem className="mobile-notebook-menu__item mobile-notebook-menu__item--danger" onClick={() => requestDeleteNotebook(notebook)}>
                        <TrashSimpleIcon size={15} weight="regular" aria-hidden="true" />
                        <span>删除</span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section>
            <div className="mobile-drawer-section-title">
              <h2>标签</h2>
            </div>
            <button type="button" className={!selectedTagId ? 'is-selected' : undefined} onClick={() => onSelectTag(null)}>
              <span className="mobile-nav-icon"><Layers3 size={16} /></span><span className="mobile-nav-label">全部</span>
            </button>
            {tags.map((tag) => (
              <button
                type="button"
                key={tag.id}
                className={tag.id === selectedTagId ? 'is-selected' : undefined}
                style={{ paddingInlineStart: `${14 + Math.min(3, tag.name.split('/').length - 1) * 14}px` }}
                onClick={() => onSelectTag(tag.id)}
              >
                <span className="mobile-nav-icon"><Hash size={15} /></span><span className="mobile-nav-label">{tag.name.split('/').slice(-1)[0]}</span>
              </button>
            ))}
          </section>
        </nav>

        {notebookDialogOpen && (
          <div className="mobile-notebook-dialog-layer" role="presentation">
            <button type="button" className="mobile-notebook-dialog-backdrop" aria-label="关闭" onClick={dismissNotebookDialog} />
            <form className="mobile-notebook-dialog" onSubmit={(event) => void submitNotebook(event)}>
              <h2>{editingNotebook ? '重命名笔记本' : '新建笔记本'}</h2>
              <input
                autoFocus
                value={notebookName}
                maxLength={120}
                placeholder="笔记本名称"
                onChange={(event) => setNotebookName(event.target.value)}
              />
              <div>
                <button type="button" onClick={dismissNotebookDialog}>取消</button>
                <button type="submit" disabled={!notebookName.trim() || savingNotebook}>{savingNotebook ? '保存中…' : '保存'}</button>
              </div>
            </form>
          </div>
        )}
        {notebookToDelete && (
          <div className="mobile-notebook-dialog-layer" role="presentation">
            <button type="button" className="mobile-notebook-dialog-backdrop" aria-label="取消删除" disabled={savingNotebook} onClick={() => setNotebookToDelete(null)} />
            <section className="mobile-notebook-dialog" role="dialog" aria-modal="true" aria-labelledby="mobile-delete-notebook-title">
              <h2 id="mobile-delete-notebook-title">删除笔记本？</h2>
              <p>“{notebookToDelete.name}”及其中的全部笔记会从此设备删除，并同步到 Flowix Cloud。</p>
              {deleteError && <p className="mobile-notebook-dialog__error" role="alert">{deleteError}</p>}
              <div>
                <button type="button" disabled={savingNotebook} onClick={() => setNotebookToDelete(null)}>取消</button>
                {!deleteError && <button type="button" className="mobile-notebook-dialog__danger" disabled={savingNotebook} onClick={() => void confirmDeleteNotebook()}>{savingNotebook ? '删除中…' : '删除'}</button>}
              </div>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}
