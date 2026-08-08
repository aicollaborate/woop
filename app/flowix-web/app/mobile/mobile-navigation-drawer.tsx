import { Hash, Layers3, LogOut, Pencil, Plus, X } from 'lucide-react';
import { useRef, useState, type FormEvent, type TouchEvent } from 'react';

import type { MobileTag } from './mobile-model';
import { NotebookIcon } from '@features/memo/components/notebook-icon';
import type { CloudState, NotebookRecord } from '@platform/tauri/mobile-client';

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
  onRenameNotebook: (id: string, name: string) => Promise<boolean>;
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
  onRenameNotebook,
}: MobileNavigationDrawerProps) {
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const [editingNotebook, setEditingNotebook] = useState<NotebookRecord | null>(null);
  const [notebookName, setNotebookName] = useState('');
  const [savingNotebook, setSavingNotebook] = useState(false);

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

  const handleTouchStart = (event: TouchEvent<HTMLElement>) => {
    const touch = event.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    setIsSwiping(false);
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
    }
  };

  const handleTouchEnd = () => {
    if (swipeOffset < -64) onClose();
    touchStartRef.current = null;
    setSwipeOffset(0);
    setIsSwiping(false);
  };

  const accountName = cloudState?.account?.user.displayName || cloudState?.account?.user.email;
  const membershipLabel = cloudState?.membership?.active
    ? cloudState.membership.expiresAt
      ? `订阅有效 · 至 ${new Date(cloudState.membership.expiresAt).toLocaleDateString()}`
      : '订阅有效'
    : cloudState?.membership?.readOnly
      ? '订阅已到期 · 云空间只读'
      : '未开通订阅';

  return (
    <div className="mobile-drawer-layer" role="presentation">
      <aside
        className="mobile-drawer"
        aria-label="笔记导航"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        style={{
          transform: swipeOffset ? `translateX(${swipeOffset}px)` : undefined,
          transition: isSwiping ? 'none' : undefined,
        }}
      >
        <div className="mobile-drawer-header">
          <button type="button" className="mobile-icon-button" aria-label="关闭导航" onClick={onClose}><X size={20} /></button>
        </div>

        <nav className="mobile-drawer-content">
          <section>
            <div className="mobile-drawer-section-title">
              <h2>笔记本</h2>
              <button type="button" className="mobile-drawer-add" aria-label="新建笔记本" onClick={showCreateNotebook}><Plus size={18} /></button>
            </div>
            {notebooks.map((notebook) => (
              <div
                key={notebook.id}
                className={`mobile-notebook-row${notebook.id === selectedNotebookId ? ' is-selected' : ''}`}
              >
                <button type="button" className="mobile-notebook-select" onClick={() => onSelectNotebook(notebook.id)}>
                  <NotebookIcon icon={notebook.icon} name={notebook.name} className="mobile-notebook-icon" />
                  <span className="mobile-nav-label">{notebook.name}</span>
                </button>
                <button type="button" className="mobile-notebook-edit" aria-label={`重命名${notebook.name}`} onClick={() => showRenameNotebook(notebook)}><Pencil size={15} /></button>
              </div>
            ))}
          </section>

          <section>
            <h2>标签</h2>
            <button type="button" className={!selectedTagId ? 'is-selected' : undefined} onClick={() => onSelectTag(null)}>
              <span className="mobile-nav-icon"><Layers3 size={16} /></span><span className="mobile-nav-label">全部笔记</span>
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

        <div className="mobile-drawer-account">
          <button type="button" onClick={onAccount}>
            <span>
              <strong>{cloudState?.authenticated ? accountName : '本地模式'}</strong>
              <small>{cloudState?.authenticated ? membershipLabel : '登录并订阅后同步'}</small>
            </span>
          </button>
          {cloudState?.account && (
            <button type="button" className="mobile-logout-button" onClick={onLogout}><LogOut size={17} />退出登录</button>
          )}
        </div>

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
      </aside>
    </div>
  );
}
