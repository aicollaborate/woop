import { CircleX, Search, SquarePen, X } from 'lucide-react';
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type LazyExoticComponent,
  type PointerEvent,
} from 'react';

import appIcon from '@/assets/app-icon-mobile.png';

import { MobileMemoList } from './mobile-memo-list';
import { MobileCloudStatusIcon } from './mobile-cloud-status-icon';
import {
  MobileDocumentErrorBoundary,
  MobileDocumentFailureScreen,
  MobileDocumentLoadingScreen,
} from './mobile-document-state';
import { MobileNavigationDrawer } from './mobile-navigation-drawer';
import { useMobileLibrary } from './use-mobile-library';

// 代码分割: 编辑器 (Tiptap 全家桶) 与账号面板按需加载, 不进列表视图主包。
// MobileDocumentScreen 拖着 @tiptap/core + markdown + starter-kit + task-*,
// 只有用户真正打开一篇笔记时才需要; MobileAccountPanel 仅在打开账号 sheet
// 时加载。两者都不在列表视图渲染路径上。
const MobileAccountPanel = lazy(() =>
  import('./mobile-account-panel').then((module) => ({ default: module.MobileAccountPanel })),
);

interface MobileDocumentScreenLoaderProps {
  retryKey: number;
}

interface MobileDocumentScreenProps {
  memoId: string;
  filename: string;
  content: string;
  manageHistory: boolean;
  onBack: () => void;
  onBackRejected: () => void;
}

const documentScreenLoaders: Array<LazyExoticComponent<ComponentType<MobileDocumentScreenProps>>> = [];

function getDocumentScreenLoader(retryKey: number) {
  if (!documentScreenLoaders[retryKey]) {
    documentScreenLoaders[retryKey] = lazy(() =>
      import('./mobile-document-screen').then((module) => ({
        default: module.MobileDocumentScreen,
      })),
    );
  }
  return documentScreenLoaders[retryKey];
}

// Start the first import at module load, preserving the existing Suspense
// behavior. Subsequent entries are created only when Error Boundary retries.
getDocumentScreenLoader(0);

/**
 * Create a fresh lazy component for each retry. React.lazy caches a rejected
 * import promise, so retrying a module-level lazy component would otherwise
 * show the same failure forever after a transient iOS chunk-load error.
 */
function MobileDocumentScreenLoader({ retryKey, ...props }: MobileDocumentScreenLoaderProps & MobileDocumentScreenProps) {
  const Screen = getDocumentScreenLoader(retryKey);
  return <Screen {...props} />;
}

function MobileBootScreen({ message }: { message: string }) {
  return (
    <main className="mobile-boot-screen" aria-busy="true">
      <img className="mobile-boot-icon" src={appIcon} alt="Flowix" width={96} height={96} />
      <p>{message}</p>
    </main>
  );
}

type MobileDocumentMotion =
  | 'entering'
  | 'steady'
  | 'dragging'
  | 'swipe-closing'
  | 'swipe-restoring'
  | 'exit-closing';

interface MobileDocumentView {
  memoId: string;
  filename: string;
  motion: MobileDocumentMotion;
}

const MOBILE_DOCUMENT_EDGE_WIDTH = 28;
const MOBILE_DOCUMENT_SWIPE_ACTIVATION_DISTANCE = 10;
const MOBILE_DOCUMENT_SWIPE_COMMIT_DISTANCE = 0.32;
const MOBILE_DOCUMENT_SWIPE_VELOCITY = 0.45;
const MOBILE_DOCUMENT_SWIPE_SETTLE_DURATION = 280;
const MOBILE_DOCUMENT_EXIT_DURATION = 320;
const MOBILE_DOCUMENT_ANIMATION_FALLBACK_PADDING = 48;

function MobileMenuIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="21"
      height="21"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 6h15" />
      <path d="M4 12h11" />
      <path d="M4 18h16" />
    </svg>
  );
}

function MobileSearchIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="21"
      height="21"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

interface MobileDocumentSwipeGesture {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastTime: number;
  velocityX: number;
  lock: 'undecided' | 'horizontal' | 'vertical';
}

interface MobileDocumentSwipeCloseProgress {
  animationDone: boolean;
  saveDone: boolean;
}

function documentMotionClass(motion: MobileDocumentMotion): string {
  if (motion === 'entering') return ' mobile-document-layer--enter';
  if (motion === 'exit-closing') return ' mobile-document-layer--exit';
  if (motion === 'dragging') return ' mobile-document-layer--swiping';
  if (motion === 'swipe-closing' || motion === 'swipe-restoring') {
    return ' mobile-document-layer--swipe-settling';
  }
  return '';
}

export function MobileApp() {
  const library = useMobileLibrary();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [documentView, setDocumentView] = useState<MobileDocumentView | null>(null);
  const [documentRetryKey, setDocumentRetryKey] = useState(0);
  const [openMemoActionsId, setOpenMemoActionsId] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const edgeGestureRef = useRef({ startX: -1, startY: 0, swiping: false });
  const documentSwipeGestureRef = useRef<MobileDocumentSwipeGesture | null>(null);
  const documentMotionRef = useRef<MobileDocumentMotion | null>(null);
  const documentSwipeCloseProgressRef = useRef<MobileDocumentSwipeCloseProgress | null>(null);
  const documentSwipeTimerRef = useRef<number | null>(null);
  const [documentSwipeOffset, setDocumentSwipeOffset] = useState(0);
  const documentCloseTimerRef = useRef<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (documentCloseTimerRef.current !== null) window.clearTimeout(documentCloseTimerRef.current);
    if (documentSwipeTimerRef.current !== null) window.clearTimeout(documentSwipeTimerRef.current);
    if (searchTimerRef.current !== null) window.clearTimeout(searchTimerRef.current);
  }, []);

  useEffect(() => {
    if (!searchOpen) return;
    const frame = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [searchOpen]);

  useEffect(() => {
    if (!library.message) return;
    const timeoutId = window.setTimeout(library.dismissMessage, 4_000);
    return () => window.clearTimeout(timeoutId);
  }, [library.dismissMessage, library.message]);

  const openDrawer = useCallback(() => {
    window.history.pushState({ flowixMobileLayer: 'drawer' }, '');
    setDrawerOpen(true);
  }, []);

  const openAccount = useCallback(() => {
    // Keep the drawer mounted when the account sheet is opened from its
    // header. The account sheet becomes a nested layer, so closing it returns
    // to the drawer instead of exposing the note list underneath.
    window.history.pushState({
      flowixMobileLayer: 'account',
      parent: drawerOpen ? 'drawer' : 'list',
    }, '');
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

  const openDocument = (id: string) => {
    void library.openMemo(id);
  };

  const scheduleSearch = useCallback((query: string) => {
    setSearchText(query);
    if (searchTimerRef.current !== null) window.clearTimeout(searchTimerRef.current);
    if (!query.trim()) {
      void library.searchMemos('');
      return;
    }
    searchTimerRef.current = window.setTimeout(() => {
      searchTimerRef.current = null;
      void library.searchMemos(query);
    }, 140);
  }, [library.searchMemos]);

  const closeSearch = useCallback(() => {
    if (searchTimerRef.current !== null) window.clearTimeout(searchTimerRef.current);
    searchTimerRef.current = null;
    setSearchOpen(false);
    setSearchText('');
    setOpenMemoActionsId(null);
    void library.searchMemos('');
  }, [library.searchMemos]);

  const clearDocumentTimers = useCallback(() => {
    if (documentCloseTimerRef.current !== null) window.clearTimeout(documentCloseTimerRef.current);
    documentCloseTimerRef.current = null;
    if (documentSwipeTimerRef.current !== null) {
      window.clearTimeout(documentSwipeTimerRef.current);
      documentSwipeTimerRef.current = null;
    }
  }, []);

  const setDocumentMotion = useCallback((motion: MobileDocumentMotion) => {
    documentMotionRef.current = motion;
    setDocumentView((current) => current ? { ...current, motion } : null);
  }, []);

  const finishDocumentUnmount = useCallback(() => {
    clearDocumentTimers();
    documentSwipeGestureRef.current = null;
    documentSwipeCloseProgressRef.current = null;
    documentMotionRef.current = null;
    setDocumentSwipeOffset(0);
    library.closeDocument();
    setDocumentView(null);
  }, [clearDocumentTimers, library.closeDocument]);

  const finishSwipedDocumentIfReady = useCallback(() => {
    const progress = documentSwipeCloseProgressRef.current;
    if (!progress?.animationDone || !progress.saveDone) return;
    finishDocumentUnmount();
  }, [finishDocumentUnmount]);

  const closeDocumentWithAnimation = useCallback(() => {
    clearDocumentTimers();
    documentSwipeGestureRef.current = null;
    documentSwipeCloseProgressRef.current = null;
    setDocumentSwipeOffset(0);
    setDocumentMotion('exit-closing');
    documentCloseTimerRef.current = window.setTimeout(() => {
      documentCloseTimerRef.current = null;
      if (documentMotionRef.current === 'exit-closing') finishDocumentUnmount();
    }, MOBILE_DOCUMENT_EXIT_DURATION + MOBILE_DOCUMENT_ANIMATION_FALLBACK_PADDING);
  }, [clearDocumentTimers, finishDocumentUnmount, setDocumentMotion]);

  const handleDocumentBackAllowed = useCallback(() => {
    const progress = documentSwipeCloseProgressRef.current;
    if (documentMotionRef.current === 'swipe-closing' && progress) {
      progress.saveDone = true;
      finishSwipedDocumentIfReady();
      return;
    }
    closeDocumentWithAnimation();
  }, [closeDocumentWithAnimation, finishSwipedDocumentIfReady]);

  const handleDocumentBackRejected = useCallback(() => {
    if (documentMotionRef.current !== 'swipe-closing') return;
    clearDocumentTimers();
    documentSwipeCloseProgressRef.current = null;
    setDocumentMotion('swipe-restoring');
    setDocumentSwipeOffset(0);
    documentSwipeTimerRef.current = window.setTimeout(() => {
      documentSwipeTimerRef.current = null;
      if (documentMotionRef.current === 'swipe-restoring') setDocumentMotion('steady');
    }, MOBILE_DOCUMENT_SWIPE_SETTLE_DURATION + MOBILE_DOCUMENT_ANIMATION_FALLBACK_PADDING);
  }, [clearDocumentTimers, setDocumentMotion]);

  // The document entry is pushed by the parent. Loading and error states do
  // not have the editor's popstate listener, so their Back controls request a
  // history pop and let the existing parent handler close the layer.
  const requestDocumentBack = useCallback(() => window.history.back(), []);
  const retryDocumentRender = useCallback(() => {
    setDocumentRetryKey((current) => current + 1);
  }, []);

  useEffect(() => {
    const opening = library.openingMemo;
    if (!opening || documentView) return;
    window.history.pushState({ flowixMobileLayer: 'document' }, '');
    documentMotionRef.current = 'entering';
    setDocumentView({ memoId: opening.id, filename: opening.filename, motion: 'entering' });
    documentCloseTimerRef.current = window.setTimeout(() => {
      documentCloseTimerRef.current = null;
      if (documentMotionRef.current === 'entering') setDocumentMotion('steady');
    }, MOBILE_DOCUMENT_EXIT_DURATION + MOBILE_DOCUMENT_ANIMATION_FALLBACK_PADDING);
  }, [documentView, library.openingMemo, setDocumentMotion]);

  useEffect(() => {
    if (
      !documentView
      || documentView.motion !== 'entering'
      || library.openingMemo
      || library.activeDocument
      || library.openMemoError
    ) return;
    documentMotionRef.current = null;
    library.closeDocument();
    setDocumentView(null);
    if (window.history.state?.flowixMobileLayer === 'document') window.history.back();
  }, [documentView, library.activeDocument, library.closeDocument, library.openMemoError, library.openingMemo]);

  useEffect(() => {
    const handleDocumentBack = () => {
      if (documentView && !library.activeDocument) closeDocumentWithAnimation();
    };
    window.addEventListener('popstate', handleDocumentBack);
    return () => window.removeEventListener('popstate', handleDocumentBack);
  }, [closeDocumentWithAnimation, documentView, library.activeDocument]);

  const handleEdgePointerDown = (event: PointerEvent<HTMLElement>) => {
    if (documentView || drawerOpen || accountOpen || event.pointerType === 'mouse' || event.clientX > 28) return;
    edgeGestureRef.current = { startX: event.clientX, startY: event.clientY, swiping: false };
  };

  const handleEdgePointerMove = (event: PointerEvent<HTMLElement>) => {
    const gesture = edgeGestureRef.current;
    if (gesture.startX < 0 || documentView || drawerOpen || accountOpen) return;
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
    if (gesture.startX < 0 || documentView) return;
    const dx = event.clientX - gesture.startX;
    if (gesture.swiping && dx > 52) {
      event.preventDefault();
      openDrawer();
    }
    edgeGestureRef.current = { startX: -1, startY: 0, swiping: false };
  };

  const handleDocumentPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (
      !documentView
      || documentView.motion !== 'steady'
      || !library.activeDocument
      || drawerOpen
      || accountOpen
      || event.pointerType === 'mouse'
      || event.button !== 0
      || event.clientX > MOBILE_DOCUMENT_EDGE_WIDTH
      || (event.target instanceof Element && event.target.closest('button, a, input, textarea, select'))
    ) return;

    if (documentSwipeTimerRef.current !== null) {
      window.clearTimeout(documentSwipeTimerRef.current);
      documentSwipeTimerRef.current = null;
    }
    documentSwipeGestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastTime: performance.now(),
      velocityX: 0,
      lock: 'undecided',
    };
  };

  const handleDocumentPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = documentSwipeGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;

    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (gesture.lock === 'undecided') {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < MOBILE_DOCUMENT_SWIPE_ACTIVATION_DISTANCE) return;
      if (dx <= 0 || Math.abs(dy) > Math.abs(dx) * 1.2) {
        gesture.lock = 'vertical';
        documentSwipeGestureRef.current = null;
        return;
      }
      gesture.lock = 'horizontal';
      setDocumentMotion('dragging');
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    if (gesture.lock !== 'horizontal') return;

    event.preventDefault();
    const now = performance.now();
    const elapsed = now - gesture.lastTime;
    if (elapsed > 0) gesture.velocityX = (event.clientX - gesture.lastX) / elapsed;
    gesture.lastX = event.clientX;
    gesture.lastTime = now;
    setDocumentSwipeOffset(Math.min(Math.max(0, dx), window.innerWidth));
  };

  const settleDocumentSwipe = (commit: boolean) => {
    const gesture = documentSwipeGestureRef.current;
    if (!gesture) return;

    const distance = Math.max(0, gesture.lastX - gesture.startX);
    const projectedDistance = distance + Math.max(0, gesture.velocityX) * 80;
    const commitDistance = Math.max(72, window.innerWidth * MOBILE_DOCUMENT_SWIPE_COMMIT_DISTANCE);
    const shouldCommit = commit && (
      projectedDistance >= commitDistance
      || (gesture.velocityX >= MOBILE_DOCUMENT_SWIPE_VELOCITY && distance >= 24)
    );
    documentSwipeGestureRef.current = null;

    if (shouldCommit) {
      documentSwipeCloseProgressRef.current = { animationDone: false, saveDone: false };
      setDocumentMotion('swipe-closing');
      setDocumentSwipeOffset(window.innerWidth);
      window.history.back();
      documentSwipeTimerRef.current = window.setTimeout(() => {
        documentSwipeTimerRef.current = null;
        const progress = documentSwipeCloseProgressRef.current;
        if (documentMotionRef.current !== 'swipe-closing' || !progress) return;
        progress.animationDone = true;
        finishSwipedDocumentIfReady();
      }, MOBILE_DOCUMENT_SWIPE_SETTLE_DURATION + MOBILE_DOCUMENT_ANIMATION_FALLBACK_PADDING);
      return;
    }

    setDocumentMotion('swipe-restoring');
    setDocumentSwipeOffset(0);
    documentSwipeTimerRef.current = window.setTimeout(() => {
      documentSwipeTimerRef.current = null;
      if (documentMotionRef.current === 'swipe-restoring') setDocumentMotion('steady');
    }, MOBILE_DOCUMENT_SWIPE_SETTLE_DURATION + MOBILE_DOCUMENT_ANIMATION_FALLBACK_PADDING);
  };

  const handleDocumentPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = documentSwipeGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.lock === 'horizontal') {
      event.preventDefault();
      settleDocumentSwipe(true);
    } else {
      documentSwipeGestureRef.current = null;
    }
  };

  const handleDocumentPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    const gesture = documentSwipeGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (gesture.lock === 'horizontal') settleDocumentSwipe(false);
    else documentSwipeGestureRef.current = null;
  };

  if (library.booting) {
    return <MobileBootScreen message="正在准备笔记…" />;
  }

  return (
    <main
      className={`mobile-shell${drawerOpen ? ' mobile-shell--drawer-open' : ''}`}
      onPointerDown={handleEdgePointerDown}
      onPointerMove={handleEdgePointerMove}
      onPointerUp={handleEdgePointerUp}
      onPointerCancel={() => { edgeGestureRef.current = { startX: -1, startY: 0, swiping: false }; }}
    >
      <div className="mobile-list-screen">
        <header className={`mobile-topbar mobile-list-topbar${searchOpen ? ' is-search-open' : ''}`}>
        <button type="button" className="mobile-icon-button mobile-menu-button" aria-label="打开导航" onClick={openDrawer}>
          <MobileMenuIcon />
        </button>
        <div className="mobile-list-heading">
          <div>
            <strong>{library.selectedTag?.name || library.selectedNotebook?.name || '笔记'}</strong>
            <span className="mobile-list-count">{library.memoItems.length}</span>
          </div>
        </div>
        <div className="mobile-list-actions" aria-label="列表操作">
          <button
            type="button"
            className="mobile-list-action"
            aria-label={library.syncing ? '正在连接 Cloud' : library.canSync ? '已连接 Cloud，点击同步' : '未连接 Cloud，打开账号与云同步'}
            disabled={library.syncing}
            onClick={() => void refresh()}
          >
            <MobileCloudStatusIcon status={library.syncing ? 'connecting' : library.canSync ? 'connected' : 'unlinked'} />
        </button>
        <button type="button" className="mobile-list-action" aria-label="搜索笔记" onClick={() => setSearchOpen(true)}>
            <MobileSearchIcon />
        </button>
        </div>
        <form className="mobile-list-search" role="search" onSubmit={(event) => event.preventDefault()}>
          <Search size={19} strokeWidth={1.9} aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="search"
            value={searchText}
            placeholder="搜索当前笔记本"
            aria-label="搜索当前笔记本"
            enterKeyHint="search"
            onChange={(event) => scheduleSearch(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') closeSearch(); }}
          />
          {searchText && (
            <button type="button" className="mobile-list-search__clear" aria-label="清除搜索" onClick={() => scheduleSearch('')}>
              <CircleX size={18} aria-hidden="true" />
            </button>
          )}
          <button type="button" className="mobile-list-search__cancel" aria-label="关闭搜索" onClick={closeSearch}>
            <X size={21} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </form>
        </header>

        {library.message && <button type="button" className="mobile-message" onClick={library.dismissMessage}>{library.message}</button>}

        <MobileMemoList
          items={library.memoItems}
          loading={library.loadingList}
          onRefresh={refresh}
          onOpen={openDocument}
          openMemoId={openMemoActionsId}
          onToggleActions={(id) => setOpenMemoActionsId((current) => current === id ? null : id)}
          onDelete={deleteMemo}
          onTogglePin={(memo) => { setOpenMemoActionsId(null); void library.toggleMemoFavorite(memo); }}
          searchQuery={searchText.trim()}
          searching={library.searching}
        />

        <button type="button" className="mobile-fab" aria-label="新建笔记" disabled={!library.selectedNotebookId} onClick={() => void library.createMemo()}>
          <SquarePen size={24} strokeWidth={1.8} />
        </button>
      </div>

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
          onDeleteNotebook={library.deleteNotebook}
          onRenameNotebook={library.renameNotebook}
        />
      )}

      {accountOpen && (
        <Suspense fallback={<div className="mobile-account-layer"><div className="mobile-drawer-backdrop" /></div>}>
          <MobileAccountPanel
            state={library.cloudState}
            syncStatus={library.syncStatus}
            onClose={closeMobileLayer}
            onLogout={() => void logout()}
            onStateChange={library.updateCloudState}
          />
        </Suspense>
      )}

      {documentView && (
        <div
          className={`mobile-document-layer${documentMotionClass(documentView.motion)}`}
          data-motion={documentView.motion}
          style={documentView.motion === 'dragging'
            || documentView.motion === 'swipe-closing'
            || documentView.motion === 'swipe-restoring'
            ? { transform: `translate3d(${documentSwipeOffset}px, 0, 0)` }
            : undefined}
          onPointerDown={handleDocumentPointerDown}
          onPointerMove={handleDocumentPointerMove}
          onPointerUp={handleDocumentPointerUp}
          onPointerCancel={handleDocumentPointerCancel}
          onAnimationEnd={(event) => {
            if (event.target !== event.currentTarget) return;
            if (documentCloseTimerRef.current !== null) {
              window.clearTimeout(documentCloseTimerRef.current);
              documentCloseTimerRef.current = null;
            }
            if (documentMotionRef.current === 'entering') setDocumentMotion('steady');
            else if (documentMotionRef.current === 'exit-closing') finishDocumentUnmount();
          }}
          onTransitionEnd={(event) => {
            if (event.target !== event.currentTarget || event.propertyName !== 'transform') return;
            if (documentSwipeTimerRef.current !== null) {
              window.clearTimeout(documentSwipeTimerRef.current);
              documentSwipeTimerRef.current = null;
            }
            if (documentMotionRef.current === 'swipe-closing') {
              const progress = documentSwipeCloseProgressRef.current;
              if (!progress) return;
              progress.animationDone = true;
              finishSwipedDocumentIfReady();
            } else if (documentMotionRef.current === 'swipe-restoring') {
              setDocumentMotion('steady');
            }
          }}
        >
          <MobileDocumentErrorBoundary
            key={library.activeDocument?.memo.id || documentView.memoId}
            onBack={requestDocumentBack}
            onRetry={retryDocumentRender}
          >
            <Suspense
              fallback={(
                <MobileDocumentLoadingScreen
                  onBack={requestDocumentBack}
                />
              )}
            >
              {library.openMemoError?.id === documentView.memoId ? (
                <MobileDocumentFailureScreen
                  kind={library.openMemoError.kind}
                  message={library.openMemoError.message}
                  onRetry={() => void library.openMemo(documentView.memoId)}
                  onBack={requestDocumentBack}
                />
              ) : library.activeDocument ? (
                <MobileDocumentScreenLoader
                  retryKey={documentRetryKey}
                  memoId={library.activeDocument.memo.id}
                  filename={library.activeDocument.memo.filename}
                  content={library.activeDocument.content}
                  manageHistory={false}
                  onBack={handleDocumentBackAllowed}
                  onBackRejected={handleDocumentBackRejected}
                />
              ) : (
                <MobileDocumentLoadingScreen
                  onBack={requestDocumentBack}
                />
              )}
            </Suspense>
          </MobileDocumentErrorBoundary>
        </div>
      )}
    </main>
  );
}
