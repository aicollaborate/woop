import { CloudOff, LoaderCircle, Menu, RefreshCw, SquarePen } from 'lucide-react';
import { Suspense, lazy, useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';

import appIcon from '@/assets/app-icon-source.png';

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

function MobileBootScreen({ message }: { message: string }) {
  return (
    <main className="mobile-boot-screen" aria-busy="true">
      <img className="mobile-boot-icon" src={appIcon} alt="Flowix" width={96} height={96} />
      <p>{message}</p>
    </main>
  );
}

function MobileDocumentLoadingScreen() {
  return (
    <main className="mobile-boot-screen" aria-busy="true">
      <LoaderCircle className="mobile-loading-spinner is-spinning" size={30} aria-hidden="true" />
      <p>正在打开笔记…</p>
    </main>
  );
}

export function MobileApp() {
  const library = useMobileLibrary();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [openMemoActionsId, setOpenMemoActionsId] = useState<string | null>(null);
  const edgeGestureRef = useRef({ startX: -1, startY: 0, swiping: false });

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
      if (library.canSync) void refresh();
    };
    window.addEventListener('online', syncAfterResume);
    return () => {
      window.removeEventListener('online', syncAfterResume);
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
    if (!await library.logout()) return;
    setDrawerOpen(false);
    setAccountOpen(false);
    closeMobileLayer();
  };

  const deleteMemo = (id: string) => {
    setOpenMemoActionsId(null);
    void library.deleteMemo(id);
  };

  const handleEdgePointerDown = (event: PointerEvent<HTMLElement>) => {
    if (drawerOpen || accountOpen || event.pointerType === 'mouse' || event.clientX > 28) return;
    edgeGestureRef.current = { startX: event.clientX, startY: event.clientY, swiping: false };
  };

  const handleEdgePointerMove = (event: PointerEvent<HTMLElement>) => {
    const gesture = edgeGestureRef.current;
    if (gesture.startX < 0 || drawerOpen || accountOpen) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (Math.abs(dy) > Math.abs(dx) * 1.2) {
      gesture.startX = -1;
      return;
    }
    if (dx > 12) gesture.swiping = true;
  };

  const handleEdgePointerUp = (event: PointerEvent<HTMLElement>) => {
    const gesture = edgeGestureRef.current;
    if (gesture.startX < 0) return;
    const dx = event.clientX - gesture.startX;
    if (gesture.swiping && dx > 52) {
      event.preventDefault();
      openDrawer();
    }
    edgeGestureRef.current = { startX: -1, startY: 0, swiping: false };
  };

  if (library.booting) {
    return <MobileBootScreen message="正在准备笔记…" />;
  }

  if (library.activeDocument) {
    return (
      <Suspense fallback={<MobileDocumentLoadingScreen />}>
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
    <main
      className={`mobile-shell${drawerOpen ? ' mobile-shell--drawer-open' : ''}`}
      onPointerDown={handleEdgePointerDown}
      onPointerMove={handleEdgePointerMove}
      onPointerUp={handleEdgePointerUp}
      onPointerCancel={() => { edgeGestureRef.current = { startX: -1, startY: 0, swiping: false }; }}
    >
      <header className="mobile-topbar mobile-list-topbar">
        <button type="button" className="mobile-icon-button" aria-label="打开导航" onClick={openDrawer}>
          <Menu size={21} strokeWidth={1.8} />
        </button>
        <div className="mobile-list-heading">
          <div>
            <strong>{library.selectedTag?.name || library.selectedNotebook?.name || '笔记'}</strong>
            <span className="mobile-list-count">{library.memoItems.length}</span>
          </div>
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
        openMemoId={openMemoActionsId}
        onToggleActions={(id) => setOpenMemoActionsId((current) => current === id ? null : id)}
        onDelete={deleteMemo}
        onTogglePin={(memo) => { setOpenMemoActionsId(null); void library.toggleMemoFavorite(memo); }}
      />

      <button type="button" className="mobile-fab" aria-label="新建笔记" disabled={!library.selectedNotebookId} onClick={() => void library.createMemo()}>
        <SquarePen size={21} strokeWidth={1.8} />
      </button>

      {drawerOpen && (
        <MobileNavigationDrawer
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
          onCreateNotebook={library.createNotebook}
          onRenameNotebook={library.renameNotebook}
        />
      )}

      {accountOpen && (
        <Suspense fallback={<div className="mobile-account-layer"><div className="mobile-drawer-backdrop" /></div>}>
          <MobileAccountPanel
            state={library.cloudState}
            syncStatus={library.syncStatus}
            onClose={closeMobileLayer}
            onStateChange={library.updateCloudState}
          />
        </Suspense>
      )}
    </main>
  );
}
