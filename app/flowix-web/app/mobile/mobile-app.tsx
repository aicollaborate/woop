import { CloudOff, Menu, RefreshCw, SquarePen } from 'lucide-react';
import { Suspense, lazy, useCallback, useEffect, useState } from 'react';

import { MobileMemoList } from './mobile-memo-list';
import { MobileNavigationDrawer } from './mobile-navigation-drawer';
import { useMobileLibrary } from './use-mobile-library';

// 代码分割: 编辑器 (Tiptap 全家桶) 与账号面板按需加载, 不进列表视图主包。
// MobileDocumentScreen 拖着 @tiptap/core + markdown + starter-kit + task-*,
// 只有用户真正打开一篇笔记时才需要; MobileAccountPanel 仅在打开账号 sheet
// 时加载。两者都不在列表视图渲染路径上。
const MobileDocumentScreen = lazy(() =>
  import('./mobile-document-screen').then((module) => ({ default: module.MobileDocumentScreen })),
);
const MobileAccountPanel = lazy(() =>
  import('./mobile-account-panel').then((module) => ({ default: module.MobileAccountPanel })),
);

export function MobileApp() {
  const library = useMobileLibrary();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  const openDrawer = useCallback(() => {
    window.history.pushState({ flowixMobileLayer: 'drawer' }, '');
    setDrawerOpen(true);
  }, []);

  const openAccount = useCallback(() => {
    if (drawerOpen) {
      window.history.replaceState({ flowixMobileLayer: 'account' }, '');
    } else {
      window.history.pushState({ flowixMobileLayer: 'account' }, '');
    }
    setDrawerOpen(false);
    setAccountOpen(true);
  }, [drawerOpen]);

  const closeMobileLayer = useCallback(() => window.history.back(), []);

  useEffect(() => {
    const handleSystemBack = () => {
      if (accountOpen) setAccountOpen(false);
      else if (drawerOpen) setDrawerOpen(false);
    };
    window.addEventListener('popstate', handleSystemBack);
    return () => window.removeEventListener('popstate', handleSystemBack);
  }, [accountOpen, drawerOpen]);

  const refresh = useCallback(async () => {
    if (!await library.syncNow()) openAccount();
  }, [library.syncNow, openAccount]);

  useEffect(() => {
    const syncAfterResume = () => {
      if (library.canSync && !document.hidden) void refresh();
    };
    window.addEventListener('online', syncAfterResume);
    document.addEventListener('visibilitychange', syncAfterResume);
    return () => {
      window.removeEventListener('online', syncAfterResume);
      document.removeEventListener('visibilitychange', syncAfterResume);
    };
  }, [library.canSync, refresh]);

  const selectNotebook = (id: string) => {
    library.selectNotebook(id);
    closeMobileLayer();
  };

  const selectTag = (id: string | null) => {
    library.selectTag(id);
    closeMobileLayer();
  };

  const logout = async () => {
    await library.logout();
    setDrawerOpen(false);
    setAccountOpen(false);
    closeMobileLayer();
  };

  if (library.booting) {
    return <main className="mobile-boot-screen"><span className="mobile-pulse-mark">F</span><p>正在准备笔记…</p></main>;
  }

  if (library.activeDocument) {
    return (
      <Suspense fallback={<main className="mobile-boot-screen"><span className="mobile-pulse-mark">F</span><p>正在打开笔记…</p></main>}>
        <MobileDocumentScreen
          memoId={library.activeDocument.memo.id}
          filename={library.activeDocument.memo.filename}
          content={library.activeDocument.content}
          onBack={library.closeDocument}
        />
      </Suspense>
    );
  }

  return (
    <main className="mobile-shell">
      <header className="mobile-topbar">
        <button type="button" className="mobile-icon-button" aria-label="打开导航" onClick={openDrawer}>
          <Menu size={21} strokeWidth={1.8} />
        </button>
        <div className="mobile-list-heading">
          <div><span className="mobile-heading-mark" aria-hidden="true" /><strong>{library.selectedTag?.name || library.selectedNotebook?.name || '笔记'}</strong></div>
          <span>{library.selectedTag ? '标签' : '笔记本'} · {library.memoItems.length} 篇</span>
        </div>
        <button type="button" className="mobile-icon-button" aria-label={library.canSync ? '同步' : '账号与云同步'} disabled={library.syncing} onClick={() => void refresh()}>
          {library.canSync
            ? <RefreshCw size={19} strokeWidth={1.8} className={library.syncing ? 'is-spinning' : undefined} />
            : <CloudOff size={19} strokeWidth={1.8} />}
        </button>
      </header>

      {library.message && <button type="button" className="mobile-message" onClick={library.dismissMessage}>{library.message}</button>}

      <MobileMemoList
        items={library.memoItems}
        loading={library.loadingList}
        onOpen={(id) => void library.openMemo(id)}
      />

      <button type="button" className="mobile-fab" aria-label="新建笔记" disabled={!library.selectedNotebookId} onClick={() => void library.createMemo()}>
        <SquarePen size={21} strokeWidth={1.8} />
      </button>

      {drawerOpen && (
        <MobileNavigationDrawer
          canSync={library.canSync}
          cloudState={library.cloudState}
          notebooks={library.notebooks}
          selectedNotebookId={library.selectedNotebookId}
          selectedTagId={library.selectedTagId}
          tags={library.tags}
          onAccount={openAccount}
          onClose={closeMobileLayer}
          onLogout={() => void logout()}
          onSelectNotebook={selectNotebook}
          onSelectTag={selectTag}
        />
      )}

      {accountOpen && (
        <Suspense fallback={<div className="mobile-account-layer"><div className="mobile-drawer-backdrop" /></div>}>
          <MobileAccountPanel
            state={library.cloudState}
            onClose={closeMobileLayer}
            onStateChange={library.updateCloudState}
          />
        </Suspense>
      )}
    </main>
  );
}
