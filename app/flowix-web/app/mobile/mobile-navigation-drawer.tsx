import { Cloud, CloudOff, Hash, Layers3, LogOut, NotebookPen, Tags, X } from 'lucide-react';

import type { MobileTag } from './mobile-model';
import { NotebookIcon } from '@features/memo/components/notebook-icon';
import type { CloudState, NotebookRecord } from '@platform/tauri/mobile-client';

interface MobileNavigationDrawerProps {
  canSync: boolean;
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
}

export function MobileNavigationDrawer({
  canSync,
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
}: MobileNavigationDrawerProps) {
  return (
    <div className="mobile-drawer-layer" role="presentation">
      <button type="button" className="mobile-drawer-backdrop" aria-label="关闭导航" onClick={onClose} />
      <aside className="mobile-drawer" aria-label="笔记导航">
        <div className="mobile-drawer-header">
          <div className="mobile-drawer-brand">
            <span className="mobile-brand-mark" aria-hidden="true"><span /></span>
            <div><strong>Flowix</strong><span>{cloudState?.authenticated ? cloudState.account?.user.email : '安静地留在本地'}</span></div>
          </div>
          <button type="button" className="mobile-icon-button" aria-label="关闭导航" onClick={onClose}><X size={20} /></button>
        </div>

        <nav className="mobile-drawer-content">
          <section>
            <h2><NotebookPen size={14} /> 笔记本</h2>
            {notebooks.map((notebook) => (
              <button
                type="button"
                key={notebook.id}
                className={notebook.id === selectedNotebookId ? 'is-selected' : undefined}
                onClick={() => onSelectNotebook(notebook.id)}
              >
                <NotebookIcon icon={notebook.icon} name={notebook.name} className="mobile-notebook-icon" />
                <span className="mobile-nav-label">{notebook.name}</span>
              </button>
            ))}
          </section>

          <section>
            <h2><Tags size={14} /> 标签</h2>
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
            <span className={`mobile-cloud-status ${canSync ? 'is-online' : ''}`}>
              {canSync ? <Cloud size={16} /> : <CloudOff size={16} />}
            </span>
            <span><strong>{canSync ? '云同步已开启' : '本地模式'}</strong><small>{cloudState?.authenticated ? '查看订阅状态' : '登录并订阅后同步'}</small></span>
          </button>
          {cloudState?.account && (
            <button type="button" className="mobile-logout-button" onClick={onLogout}><LogOut size={17} />退出登录</button>
          )}
        </div>
      </aside>
    </div>
  );
}
