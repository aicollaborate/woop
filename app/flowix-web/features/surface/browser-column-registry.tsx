'use client';

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ComponentProps,
  type FormEvent,
  type ReactNode,
} from 'react';
import { ArrowLeft, ArrowRight, ChevronRight, Globe, RotateCw, Trash2 } from 'lucide-react';
import { CaretDownIcon, DotsThreeIcon, FolderSimpleIcon, PlusIcon } from '@phosphor-icons/react';
import { LazyAgentConversationDetail } from '@features/agent/components/lazy-agent-conversation-detail';
import { DocumentContainer } from '@features/document/components/document-container';
import { FolderFileTree } from '@features/memo/components/folder-file-tree';
import { useFolderTree } from '@features/memo/components/use-folder-tree';
import { useMemoStore } from '@features/memo/store';
import { useAgentAccessStore } from '@features/agent/store/agent-access-store';
import { normalizeFilesDefaults } from '@/lib/agent-access-defaults';
import { toast } from '@/lib/toast';
import { useI18n } from '@/lib/i18n';
import { openPath } from '@platform/tauri/opener';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@shared/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@shared/ui/popover';
import {
  useBrowserColumnStore,
  type BrowserColumnTab,
  type BrowserColumnWebNavigationPhase,
  type BrowserColumnWebRuntime,
} from '@features/workspace/store/browser-column-store';
import { canonicalUrl } from '@features/workspace/store/workspace-content-identity';
import {
  resolveFileBrowserBreadcrumbItems,
  type FileBrowserBreadcrumbItem,
} from './file-browser-breadcrumb';
import { getCurrentWindow } from '@platform/tauri/window';
import {
  BrowserColumnWebviewManager,
  type BrowserColumnWebviewBounds,
} from './browser-column-webview-manager';
import { files, type FileBrowserDirectoriesChangedEvent } from '@platform/tauri/client';
import { subscribe } from '@platform/tauri/event-bus';
import { canonicalPath } from '@/lib/path';
import { createLogger } from '@/lib/logger';

const BROWSER_COLUMN_NAVIGATION_EVENT = 'flowix-browser-column-navigation';
const FILE_BROWSER_DIRECTORIES_CHANGED_EVENT = 'file-browser-directories-changed';
const fileBrowserLogger = createLogger('file-browser-watch');

function canonicalDirectoryPath(path: string): string {
  const canonical = canonicalPath(path);
  const trimmed = canonical.replace(/\/+$/, '');
  return trimmed || (canonical.startsWith('/') ? '/' : canonical);
}

interface BrowserColumnNavigationEvent {
  webviewLabel: string;
  url: string;
  phase: BrowserColumnWebNavigationPhase;
}

export type BrowserColumnSurfaceCapability =
  | 'edit'
  | 'search'
  | 'web-navigation'
  | 'stream-conversation'
  | 'fullscreen'
  | 'fit'
  | 'zoom';

interface SurfaceBase {
  instanceKey: string;
  tabId: string;
  /** Changes whenever the host layout may have moved the native child. */
  layoutKey: string;
  /** DOM portals cannot cover a native child WebView. */
  nativeOverlayOpen: boolean;
}

export interface BrowserDocumentSurface extends SurfaceBase {
  kind: 'document';
  props: ComponentProps<typeof DocumentContainer>;
}

export interface BrowserFileBrowserSurface extends SurfaceBase {
  kind: 'file-browser';
  folderPath: string;
  activeFilePath: string | null;
  fileTreeVisible: boolean;
  fileTreeWidth: number;
  toolbarCollapsed: boolean;
  onToolbarCollapsedChange: (collapsed: boolean) => void;
}

export interface BrowserWebSurface extends SurfaceBase {
  kind: 'web';
  url: string;
  title: string;
  runtime: BrowserColumnWebRuntime | null;
}

export interface BrowserArtifactSurface extends SurfaceBase {
  kind: 'artifact';
  props: { memoId: string; transitionId?: number };
}

export interface BrowserAgentConversationSurface extends SurfaceBase {
  kind: 'agent-conversation';
  instanceId: string;
}

export type BrowserColumnSurface =
  | BrowserDocumentSurface
  | BrowserFileBrowserSurface
  | BrowserWebSurface
  | BrowserArtifactSurface
  | BrowserAgentConversationSurface;

export type BrowserColumnSurfaceKind = BrowserColumnSurface['kind'];

export interface BrowserColumnSurfaceDefinition {
  capabilities: readonly BrowserColumnSurfaceCapability[];
  render: (surface: BrowserColumnSurface) => ReactNode;
}

export type BrowserColumnDocumentFlush = (() => Promise<boolean>) | null;
export type BrowserColumnFlushRegistration = (flush: BrowserColumnDocumentFlush) => void;

let externalWebviewSequence = 0;

function browserTitleForUrl(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function browserFaviconForUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

function BrowserWebSurfaceView({ surface }: { surface: BrowserWebSurface }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const webviewManagerRef = useRef<BrowserColumnWebviewManager | null>(null);
  const nativeOverlayOpenRef = useRef(surface.nativeOverlayOpen);
  nativeOverlayOpenRef.current = surface.nativeOverlayOpen;
  const isNativeTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  const runtime = surface.runtime;
  const currentUrl = runtime?.currentUrl ?? surface.url;
  const reloadToken = runtime?.reloadToken ?? 0;
  const [address, setAddress] = useState(currentUrl);
  const [addressError, setAddressError] = useState<string | null>(null);
  const setWebRuntime = useBrowserColumnStore((state) => state.setWebRuntime);
  const navigateWebTab = useBrowserColumnStore((state) => state.navigateWebTab);
  const goBackWebTab = useBrowserColumnStore((state) => state.goBackWebTab);
  const goForwardWebTab = useBrowserColumnStore((state) => state.goForwardWebTab);
  const reloadWebTab = useBrowserColumnStore((state) => state.reloadWebTab);
  const updateTabMetadata = useBrowserColumnStore((state) => state.updateTabMetadata);

  useEffect(() => {
    setAddress(currentUrl);
  }, [currentUrl]);

  useEffect(() => {
    if (runtime) return;
    setWebRuntime(surface.tabId, {
      currentUrl: surface.url,
      history: [surface.url],
      historyIndex: 0,
      reloadToken: 0,
      isLoading: false,
      error: null,
    });
  }, [runtime, setWebRuntime, surface.tabId, surface.url]);

  const reportRuntime = useCallback((patch: Partial<BrowserColumnWebRuntime>) => {
    const current = useBrowserColumnStore.getState().webRuntimes[surface.tabId] ?? {
      currentUrl,
      history: [currentUrl],
      historyIndex: 0,
      reloadToken,
      isLoading: false,
      error: null,
    };
    setWebRuntime(surface.tabId, { ...current, ...patch });
  }, [currentUrl, reloadToken, setWebRuntime, surface.tabId]);

  const handleNavigate = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = canonicalUrl(address);
    if (!normalized) {
      setAddressError('请输入 http:// 或 https:// 地址');
      return;
    }
    setAddressError(null);
    setAddress(normalized);
    navigateWebTab(surface.tabId, normalized);
    updateTabMetadata(surface.tabId, {
      icon: browserFaviconForUrl(normalized),
      title: browserTitleForUrl(normalized),
    });
  }, [address, navigateWebTab, surface.tabId, updateTabMetadata]);

  const handleIframeLoad = useCallback(() => {
    const iframe = iframeRef.current;
    let loadedUrl = currentUrl;
    let pageTitle = '';
    try {
      const href = iframe?.contentWindow?.location.href;
      loadedUrl = canonicalUrl(href ?? '') ?? currentUrl;
      pageTitle = iframe?.contentDocument?.title?.trim() ?? '';
    } catch {
      // Cross-origin pages intentionally do not expose their URL/title to the
      // host document. Keep the address bar and tab title at their last known
      // values in that case.
    }

    const runtimeNow = useBrowserColumnStore.getState().webRuntimes[surface.tabId];
    if (runtimeNow && loadedUrl !== runtimeNow.currentUrl) {
      const history = runtimeNow.history.slice(0, runtimeNow.historyIndex + 1);
      if (history[history.length - 1] !== loadedUrl) history.push(loadedUrl);
      reportRuntime({
        currentUrl: loadedUrl,
        history,
        historyIndex: history.length - 1,
        isLoading: false,
        error: null,
      });
    } else {
      reportRuntime({ isLoading: false, error: null });
    }
    updateTabMetadata(surface.tabId, {
      title: pageTitle || browserTitleForUrl(loadedUrl),
      icon: browserFaviconForUrl(loadedUrl),
    });
  }, [currentUrl, reportRuntime, surface.tabId, updateTabMetadata]);

  const readBounds = useCallback((): BrowserColumnWebviewBounds | null => {
    const viewport = viewportRef.current;
    if (!viewport) return null;
    const rect = viewport.getBoundingClientRect();
    return {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }, []);

  const syncBounds = useCallback(() => {
    const bounds = readBounds();
    if (bounds) webviewManagerRef.current?.setBounds(bounds);
  }, [readBounds]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !isNativeTauri) return;

    const label = `browser-column-webpage-${++externalWebviewSequence}`;
    const currentWindow = getCurrentWindow();
    let disposed = false;
    let unlistenNavigation: (() => void) | null = null;
    let unlistenWindowResize: (() => void) | null = null;
    let unlistenScaleChanged: (() => void) | null = null;
    try {
      reportRuntime({ isLoading: true, error: null });
      void currentWindow.listen<BrowserColumnNavigationEvent>(
        BROWSER_COLUMN_NAVIGATION_EVENT,
        (event) => {
          const payload = event.payload;
          if (disposed || payload?.webviewLabel !== label) return;
          const normalized = canonicalUrl(payload.url);
          if (!normalized) return;
          const phase = payload.phase;
          if (phase !== 'navigating' && phase !== 'started' && phase !== 'finished') return;
          const synced = useBrowserColumnStore.getState().syncWebTabNavigation(
            surface.tabId,
            normalized,
            phase,
          );
          if (!synced) return;
          updateTabMetadata(surface.tabId, {
            title: browserTitleForUrl(normalized),
            icon: browserFaviconForUrl(normalized),
          });
        },
      ).then((unlisten) => {
        if (disposed) unlisten();
        else unlistenNavigation = unlisten;
      }).catch(() => undefined);

      const initialBounds = readBounds();
      if (!initialBounds) return;
      const manager = new BrowserColumnWebviewManager(currentWindow, {
        label,
        url: currentUrl,
        bounds: initialBounds,
        onCreated: () => {
          if (disposed) return;
          reportRuntime({ isLoading: false, error: null });
          manager.setVisible(!nativeOverlayOpenRef.current);
          syncBounds();
        },
        onError: (event) => {
          console.error('Failed to create browser-column webpage WebView', event);
          if (!disposed) reportRuntime({ isLoading: false, error: '网页视图创建失败' });
        },
      });
      webviewManagerRef.current = manager;
      manager.setVisible(!nativeOverlayOpenRef.current);

      const observer = new ResizeObserver(syncBounds);
      observer.observe(viewport);
      window.addEventListener('resize', syncBounds);
      const visualViewport = window.visualViewport;
      visualViewport?.addEventListener('resize', syncBounds);
      visualViewport?.addEventListener('scroll', syncBounds);
      void currentWindow.onResized(() => syncBounds()).then((unlisten) => {
        if (disposed) unlisten();
        else unlistenWindowResize = unlisten;
      }).catch(() => undefined);
      void currentWindow.onScaleChanged(() => syncBounds()).then((unlisten) => {
        if (disposed) unlisten();
        else unlistenScaleChanged = unlisten;
      }).catch(() => undefined);
      return () => {
        disposed = true;
        unlistenNavigation?.();
        unlistenWindowResize?.();
        unlistenScaleChanged?.();
        observer.disconnect();
        window.removeEventListener('resize', syncBounds);
        visualViewport?.removeEventListener('resize', syncBounds);
        visualViewport?.removeEventListener('scroll', syncBounds);
        if (webviewManagerRef.current === manager) webviewManagerRef.current = null;
        manager.dispose();
      };
    } catch (error) {
      console.error('Failed to initialize browser-column webpage WebView', error);
      reportRuntime({ isLoading: false, error: '网页视图初始化失败' });
    }
  }, [currentUrl, isNativeTauri, readBounds, reloadToken, reportRuntime, syncBounds]);

  useEffect(() => {
    if (!isNativeTauri) return;
    webviewManagerRef.current?.setVisible(!surface.nativeOverlayOpen);
  }, [isNativeTauri, surface.nativeOverlayOpen]);

  // Width changes are observed by ResizeObserver, but a column can also move
  // horizontally while keeping the same size. Track the host transition after
  // every layout-key change so native and DOM geometry converge together.
  useEffect(() => {
    if (!isNativeTauri) return;
    let frame = 0;
    const deadline = performance.now() + 300;
    const trackLayout = () => {
      syncBounds();
      if (performance.now() < deadline) frame = requestAnimationFrame(trackLayout);
    };
    trackLayout();
    return () => cancelAnimationFrame(frame);
  }, [isNativeTauri, surface.layoutKey, syncBounds]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--background)]">
      <form
        onSubmit={handleNavigate}
        className="flex shrink-0 items-center gap-1 border-b border-[var(--divider)] bg-[var(--bg-titlebar)] px-2 py-1.5"
      >
        <button
          type="button"
          aria-label="后退"
          title="后退"
          disabled={!runtime || runtime.historyIndex <= 0}
          onClick={() => goBackWebTab(surface.tabId)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] disabled:opacity-35"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="前进"
          title="前进"
          disabled={!runtime || runtime.historyIndex >= runtime.history.length - 1}
          onClick={() => goForwardWebTab(surface.tabId)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] disabled:opacity-35"
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label="重新加载"
          title="重新加载"
          onClick={() => reloadWebTab(surface.tabId)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
        >
          <RotateCw className="h-3.5 w-3.5" />
        </button>
        <div className="flex min-w-0 flex-1 items-center rounded-md border border-[var(--border)] bg-[var(--background)] px-2">
          <Globe className="mr-1.5 h-3.5 w-3.5 shrink-0 text-[var(--muted-foreground)]" />
          <input
            aria-label="网页地址"
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              setAddressError(null);
            }}
            className="h-7 min-w-0 flex-1 bg-transparent text-xs text-[var(--foreground)] outline-none"
            spellCheck={false}
          />
        </div>
        {runtime?.isLoading && <span className="shrink-0 text-[10px] text-[var(--muted-foreground)]">加载中</span>}
        {runtime?.error && <span className="shrink-0 text-[10px] text-red-500">{runtime.error}</span>}
      </form>
      {addressError && <div className="shrink-0 px-3 py-1 text-[10px] text-red-500">{addressError}</div>}
      <div ref={viewportRef} className="relative min-h-0 min-w-0 flex-1 bg-white">
        {!isNativeTauri && (
          <iframe
            key={`${surface.tabId}:${currentUrl}:${reloadToken}`}
            ref={iframeRef}
            title={surface.title}
            src={currentUrl}
            onLoad={handleIframeLoad}
            onError={() => reportRuntime({ isLoading: false, error: '网页加载失败' })}
            className="h-full w-full border-0"
            referrerPolicy="no-referrer"
          />
        )}
      </div>
    </div>
  );
}

const PluginDocumentView = lazy(() =>
  import('@features/plugin/plugin-document-view').then((module) => ({
    default: module.PluginDocumentView,
  })),
);

function BrowserDocumentSurfaceView({ surface }: { surface: BrowserDocumentSurface }) {
  return <DocumentContainer {...surface.props} />;
}

function BrowserBreadcrumbFolderTree({
  folderPath,
  folderName,
  activeFilePath,
  onFileSelect,
}: {
  folderPath: string;
  folderName: string;
  activeFilePath: string | null;
  onFileSelect: (filePath: string) => void;
}) {
  const tree = useFolderTree(folderPath);

  return (
    <div className="w-[min(236px,calc(100vw-2rem))] overflow-hidden rounded-[inherit]">
      <FolderFileTree
        folderPath={folderPath}
        folderName={folderName}
        activeFilePath={activeFilePath}
        expandToActiveFile={false}
        layout="content"
        treeViewportClassName="max-h-[min(376px,calc(100vh-7rem))]"
        tree={tree}
        onFileSelect={onFileSelect}
      />
    </div>
  );
}

function BrowserBreadcrumbFolderPopover({
  item,
  activeFilePath,
  onFileSelect,
}: {
  item: FileBrowserBreadcrumbItem;
  activeFilePath: string | null;
  onFileSelect: (filePath: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`打开文件夹 ${item.label}`}
          aria-expanded={open}
          title={item.path}
          className="max-w-[180px] truncate rounded px-1 text-left transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] data-[state=open]:bg-[var(--muted)] data-[state=open]:text-[var(--foreground)]"
        >
          {item.label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={6}
        className="w-auto overflow-hidden rounded-xl p-0 shadow-[0_8px_30px_-5px_rgb(0_0_0_/_0.28)]"
      >
        {open && (
          <BrowserBreadcrumbFolderTree
            folderPath={item.path}
            folderName={item.label}
            activeFilePath={activeFilePath}
            onFileSelect={(filePath) => {
              setOpen(false);
              onFileSelect(filePath);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

function BrowserFileBrowserSurfaceView({ surface }: { surface: BrowserFileBrowserSurface }) {
  const selectFile = useBrowserColumnStore((state) => state.selectFileBrowserFile);
  const switchFolder = useBrowserColumnStore((state) => state.switchFileBrowserFolder);
  const setTreeVisible = useBrowserColumnStore((state) => state.setFileBrowserTreeVisible);
  const { t } = useI18n();
  const selectedNotebook = useMemoStore((state) => state.selectedNotebook);
  const config = useAgentAccessStore((state) => state.config);
  const addFolderFromPicker = useAgentAccessStore((state) => state.addFolderFromPicker);
  const setDefaultFiles = useAgentAccessStore((state) => state.setDefaultFiles);
  const breadcrumbs = resolveFileBrowserBreadcrumbItems(surface.folderPath, surface.activeFilePath);
  const currentPath = surface.activeFilePath ?? surface.folderPath;
  const notebookId = selectedNotebook?.id;
  const defaultFiles = notebookId
    ? normalizeFilesDefaults(config?.defaults?.files)[notebookId]
    : undefined;
  const folderItems = (defaultFiles?.folders ?? []).map((path) => {
    const entry = config.entries.find(
      (candidate) => candidate.kind === 'folder'
        && candidate.path.trim().replace(/[\\/]+$/, '').toLowerCase()
          === path.trim().replace(/[\\/]+$/, '').toLowerCase(),
    );
    const trimmed = path.replace(/[\\/]+$/, '');
    return {
      path,
      name: entry?.name ?? trimmed.split(/[\\/]/).pop() ?? trimmed,
      missing: entry?.missing ?? true,
    };
  });

  const handleRemoveFolder = useCallback(async (path: string) => {
    if (!notebookId) return;
    const latestConfig = useAgentAccessStore.getState().config;
    const latestFiles = normalizeFilesDefaults(latestConfig.defaults?.files)[notebookId];
    const latestFolders = latestFiles?.folders ?? [];
    const comparable = (value: string) => value.trim().replace(/[\\/]+$/, '').toLowerCase();
    const nextFolders = latestFolders.filter((candidate) => comparable(candidate) !== comparable(path));
    const latestWorkspace = latestFiles?.workspace;
    const wasWorkspace =
      (typeof latestWorkspace === 'string' && comparable(latestWorkspace) === comparable(path))
      || (latestWorkspace === undefined && latestFolders[0] !== undefined
        && comparable(latestFolders[0]) === comparable(path));
    const saved = await setDefaultFiles(notebookId, {
      workspace: wasWorkspace ? null : latestWorkspace ?? null,
      folders: nextFolders,
      notebooks: latestFiles?.notebooks ?? [],
    });
    if (!saved) {
      toast.error(t('agent.access.saveFailed'));
      return;
    }
    const item = folderItems.find((candidate) => comparable(candidate.path) === comparable(path));
    toast.success(t('agent.access.folderDeleted', { name: item?.name ?? path }));
  }, [folderItems, notebookId, setDefaultFiles, t]);

  const handleAddFolder = useCallback(async () => {
    const result = await addFolderFromPicker();
    if (!result.ok) {
      if (result.code === 'already-tracked') {
        toast.error(t('agent.access.alreadyTracked'));
      } else if (result.code === 'save-failed') {
        toast.error(t('agent.access.saveFailed'));
      }
      return;
    }
    if (!notebookId) return;

    const latestConfig = useAgentAccessStore.getState().config;
    const latestFiles = normalizeFilesDefaults(latestConfig.defaults?.files)[notebookId];
    if (
      (latestFiles?.folders ?? []).some(
        (path) => path.trim().replace(/[\\/]+$/, '').toLowerCase()
          === result.entry.path.trim().replace(/[\\/]+$/, '').toLowerCase(),
      )
    ) {
      toast.info(t('agent.access.folderExists'));
      return;
    }
    const nextFolders = Array.from(new Set([...(latestFiles?.folders ?? []), result.entry.path]));
    const latestWorkspace = latestFiles?.workspace;
    const saved = await setDefaultFiles(notebookId, {
      workspace:
        latestWorkspace && nextFolders.includes(latestWorkspace)
          ? latestWorkspace
          : nextFolders[0],
      folders: nextFolders,
      notebooks: latestFiles?.notebooks ?? [],
    });
    if (!saved) toast.error(t('agent.access.saveFailed'));
  }, [addFolderFromPicker, notebookId, setDefaultFiles, t]);

  const handleCopyPath = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(currentPath);
      toast.success(t('memo.fileTree.pathCopied'));
    } catch {
      toast.error(t('memo.fileTree.copyFailed'));
    }
  }, [currentPath, t]);

  const handleOpenWithDefaultApp = useCallback(() => {
    void openPath(currentPath).catch(() => {
      toast.error(t('memo.fileTree.openFailed'));
    });
  }, [currentPath, t]);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <nav
        aria-label="文件路径"
        className="flex h-9 min-w-0 shrink-0 items-center gap-1 border-b border-[color-mix(in_oklch,var(--border)_68%,transparent)] px-2.5 text-xs text-[var(--muted-foreground)]"
      >
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {breadcrumbs.map((item, index) => (
            <span key={`${item.path}-${index}`} className="flex min-w-0 shrink-0 items-center gap-1">
              {index > 0 && <ChevronRight className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />}
              {item.type === 'folder' ? (
                <BrowserBreadcrumbFolderPopover
                  item={item}
                  activeFilePath={surface.activeFilePath}
                  onFileSelect={(filePath) => selectFile(surface.tabId, filePath)}
                />
              ) : (
                <span
                  className="max-w-[220px] truncate text-[var(--foreground)]"
                  title={item.label}
                >
                  {item.label}
                </span>
              )}
            </span>
          ))}
        </div>
        <DropdownMenu className="shrink-0">
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('memo.fileTree.sourceMenu')}
              title={t('memo.fileTree.sourceMenu')}
              className="flex h-6 shrink-0 items-center gap-0.5 rounded-md px-1 text-[var(--foreground)] transition-colors hover:bg-[var(--muted)] data-[state=open]:bg-[var(--muted)]"
            >
              <span>{t('memo.navigation.files')}</span>
              <CaretDownIcon size={10} weight="bold" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            side="bottom"
            className="min-w-[220px] rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
          >
            {folderItems.map((item) => (
              <DropdownMenuItem
                key={item.path}
                title={item.missing ? t('agent.access.pathMissing') : item.path}
                onClick={() => {
                  if (!item.missing) switchFolder(surface.tabId, item.path);
                }}
                onTrailingAction={() => void handleRemoveFolder(item.path)}
                trailingAction={<Trash2 className="h-3 w-3" aria-hidden="true" />}
                trailingActionLabel={t('agent.access.deleteFolder')}
                className={`group h-7 gap-2 rounded-lg px-2 py-0 text-left text-sm hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)] ${item.missing ? 'text-[var(--muted-foreground)]' : ''}`}
              >
                <FolderSimpleIcon size={15} weight={item.missing ? 'regular' : 'fill'} aria-hidden="true" />
                <span className="min-w-0 truncate">{item.name}</span>
              </DropdownMenuItem>
            ))}
            {folderItems.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem
              onClick={() => void handleAddFolder()}
              className="h-7 gap-2 rounded-lg px-2 py-0 text-left text-sm text-[var(--muted-foreground)] hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
            >
              <PlusIcon size={15} weight="regular" aria-hidden="true" />
              {t('memo.fileTree.addFolder')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu className="shrink-0">
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('memo.fileTree.moreActions')}
              title={t('memo.fileTree.moreActions')}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] data-[state=open]:bg-[var(--muted)] data-[state=open]:text-[var(--foreground)]"
            >
              <DotsThreeIcon size={16} weight="bold" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            side="bottom"
            className="min-w-[160px] rounded-xl p-1 shadow-[0_4px_24px_-3px_rgb(0_0_0_/_0.24)]"
          >
            <DropdownMenuItem
              onClick={() => void handleCopyPath()}
              className="h-7 items-center justify-start rounded-lg px-2 py-0 text-left text-sm hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
            >
              {t('memo.fileTree.copyPath')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={handleOpenWithDefaultApp}
              className="h-7 items-center justify-start rounded-lg px-2 py-0 text-left text-sm hover:bg-[var(--brand)] hover:text-[var(--primary-foreground)]"
            >
              {t('memo.fileTree.openDefaultApp')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          aria-label={surface.fileTreeVisible ? '关闭文件树' : '展开文件树'}
          title={surface.fileTreeVisible ? '关闭文件树' : '展开文件树'}
          aria-pressed={surface.fileTreeVisible}
          onClick={() => setTreeVisible(surface.tabId, !surface.fileTreeVisible)}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors ${surface.fileTreeVisible
            ? 'bg-[var(--muted)] text-[var(--foreground)]'
            : 'text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]'}`}
        >
          <FolderSimpleIcon className="h-4 w-4" aria-hidden="true" />
        </button>
      </nav>
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <div className="min-w-0 flex-1">
          {surface.activeFilePath ? (
            <DocumentContainer
              filePath={surface.activeFilePath}
              isExternalDocument
              externalScopePath={surface.folderPath}
              documentSessionMode="isolated"
              toolbarCollapsed={surface.toolbarCollapsed}
              onToolbarCollapsedChange={surface.onToolbarCollapsedChange}
            />
          ) : (
            <div className="flex h-full items-center justify-center px-8 text-center text-sm text-[var(--muted-foreground)]">
              从右侧文件树选择文件
            </div>
          )}
        </div>
        <BrowserFileBrowserTreePane
          surface={surface}
          onRequestClose={() => setTreeVisible(surface.tabId, false)}
          onFileSelect={(filePath) => selectFile(surface.tabId, filePath)}
        />
      </div>
    </div>
  );
}

/**
 * Own the tree state separately from the document surface. Directory events
 * can then update a visible tree without rerendering the open document.
 * The component stays mounted while the panel is hidden, so its active-tab
 * watcher and lazy-tree cache survive the toolbar toggle.
 */
function BrowserFileBrowserTreePane({
  surface,
  onRequestClose,
  onFileSelect,
}: {
  surface: BrowserFileBrowserSurface;
  onRequestClose: () => void;
  onFileSelect: (filePath: string) => void;
}) {
  const setTreeWidth = useBrowserColumnStore((state) => state.setFileBrowserTreeWidth);
  const tree = useFolderTree(surface.folderPath);
  const refreshDirectoriesRef = useRef(tree.refreshDirectories);
  refreshDirectoriesRef.current = tree.refreshDirectories;
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef({ x: 0, width: surface.fileTreeWidth });

  // BrowserColumn only mounts the active surface. Keep this lease at the
  // surface level so switching tabs stops the recursive watcher even when the
  // file-tree panel itself is currently closed.
  useEffect(() => {
    let disposed = false;
    let leaseId: string | null = null;
    const rootPath = canonicalDirectoryPath(surface.folderPath);
    const unlisten = subscribe<FileBrowserDirectoriesChangedEvent>(
      FILE_BROWSER_DIRECTORIES_CHANGED_EVENT,
      (payload) => {
        if (disposed || canonicalDirectoryPath(payload.rootPath) !== rootPath) return;
        if (leaseId && payload.leaseId !== leaseId) return;
        void refreshDirectoriesRef.current(payload.directories);
      },
    );

    void files.watchRoot(surface.folderPath)
      .then((nextLeaseId) => {
        if (disposed) {
          void files.unwatchRoot(nextLeaseId).catch((error) => {
            fileBrowserLogger.warn('releasing late directory watcher failed', { error });
          });
          return;
        }
        leaseId = nextLeaseId;
      })
      .catch((error) => {
        if (!disposed) {
          fileBrowserLogger.warn('registering directory watcher failed', {
            folderPath: surface.folderPath,
            error,
          });
        }
      });

    return () => {
      disposed = true;
      unlisten();
      if (leaseId) {
        void files.unwatchRoot(leaseId).catch((error) => {
          fileBrowserLogger.warn('releasing directory watcher failed', { error });
        });
      }
    };
  }, [surface.folderPath]);

  useEffect(() => {
    if (!isResizing) return;
    const onMove = (event: PointerEvent) => {
      setTreeWidth(surface.tabId, resizeStartRef.current.width + resizeStartRef.current.x - event.clientX);
    };
    const stop = () => setIsResizing(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', stop, { once: true });
    window.addEventListener('pointercancel', stop, { once: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, [isResizing, setTreeWidth, surface.tabId]);

  if (!surface.fileTreeVisible) return null;

  return (
    <div
      className="relative shrink-0 border-l border-[color-mix(in_oklch,var(--border)_68%,transparent)]"
      style={{ width: surface.fileTreeWidth }}
    >
      <div
        role="separator"
        aria-label="调整文件树宽度"
        aria-orientation="vertical"
        onPointerDown={(event) => {
          event.preventDefault();
          resizeStartRef.current = { x: event.clientX, width: surface.fileTreeWidth };
          setIsResizing(true);
        }}
        className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize"
      />
      <FolderFileTree
        folderPath={surface.folderPath}
        folderName={surface.folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? surface.folderPath}
        embedded
        activeFilePath={surface.activeFilePath}
        tree={tree}
        onRequestClose={onRequestClose}
        onFileSelect={(filePath) => onFileSelect(filePath)}
      />
    </div>
  );
}

function BrowserArtifactSurfaceView({ surface }: { surface: BrowserArtifactSurface }) {
  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">正在加载插件产物…</div>}>
      <PluginDocumentView {...surface.props} />
    </Suspense>
  );
}

function BrowserAgentConversationSurfaceView({ surface }: { surface: BrowserAgentConversationSurface }) {
  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">正在加载 Agent 对话…</div>}>
      <LazyAgentConversationDetail instanceId={surface.instanceId} />
    </Suspense>
  );
}

type SurfaceOfKind<K extends BrowserColumnSurfaceKind> = Extract<BrowserColumnSurface, { kind: K }>;

function defineSurface<K extends BrowserColumnSurfaceKind>(
  kind: K,
  options: {
    capabilities?: readonly BrowserColumnSurfaceCapability[];
    component: ComponentType<{ surface: SurfaceOfKind<K> }>;
  },
): BrowserColumnSurfaceDefinition {
  const Component = options.component;
  return Object.freeze({
    capabilities: Object.freeze([...(options.capabilities ?? [])]),
    render(surface: BrowserColumnSurface) {
      if (surface.kind !== kind) {
        throw new Error(`BrowserColumn surface registry mismatch: expected '${kind}', received '${surface.kind}'`);
      }
      return <Component surface={surface as SurfaceOfKind<K>} />;
    },
  });
}

export const browserColumnSurfaceRegistry = Object.freeze({
  document: defineSurface('document', {
    capabilities: ['edit', 'search'],
    component: BrowserDocumentSurfaceView,
  }),
  'file-browser': defineSurface('file-browser', {
    capabilities: [],
    component: BrowserFileBrowserSurfaceView,
  }),
  web: defineSurface('web', {
    capabilities: ['web-navigation'],
    component: BrowserWebSurfaceView,
  }),
  artifact: defineSurface('artifact', {
    capabilities: ['fullscreen', 'fit', 'zoom'],
    component: BrowserArtifactSurfaceView,
  }),
  'agent-conversation': defineSurface('agent-conversation', {
    capabilities: ['stream-conversation'],
    component: BrowserAgentConversationSurfaceView,
  }),
} satisfies Record<BrowserColumnSurfaceKind, BrowserColumnSurfaceDefinition>);

export function resolveBrowserColumnSurface(
  tab: BrowserColumnTab,
  readOnly: boolean,
  onFlushReady?: BrowserColumnFlushRegistration,
  webRuntime?: BrowserColumnWebRuntime | null,
  toolbarCollapsed = false,
  onToolbarCollapsedChange?: (collapsed: boolean) => void,
  layoutKey = '',
  nativeOverlayOpen = false,
): BrowserColumnSurface {
  const base = {
    instanceKey: `tab:${tab.id}`,
    tabId: tab.id,
    layoutKey,
    nativeOverlayOpen,
  };
  switch (tab.target.kind) {
    case 'memo':
      return {
        ...base,
        kind: 'document',
        props: {
          filePath: tab.target.filePath,
          memoId: tab.target.memoId,
          notebookId: tab.target.notebookId || null,
          notebookPath: tab.target.notebookPath || null,
          documentSessionMode: 'isolated',
          readOnly,
          onFlushReady,
          toolbarCollapsed,
          onToolbarCollapsedChange,
        },
      };
    case 'file':
      return {
        ...base,
        kind: 'document',
        props: {
          filePath: tab.target.filePath,
          isExternalDocument: true,
          externalScopePath: tab.target.scopePath,
          documentSessionMode: 'isolated',
          readOnly,
          onFlushReady,
          toolbarCollapsed,
          onToolbarCollapsedChange,
        },
      };
    case 'file-browser':
      return {
        ...base,
        kind: 'file-browser',
        folderPath: tab.target.folderPath,
        activeFilePath: tab.target.activeFilePath,
        fileTreeVisible: tab.target.fileTreeVisible,
        fileTreeWidth: tab.target.fileTreeWidth,
        toolbarCollapsed,
        onToolbarCollapsedChange: onToolbarCollapsedChange ?? (() => undefined),
      };
    case 'web':
      return {
        ...base,
        kind: 'web',
        url: tab.target.url,
        title: tab.title,
        runtime: webRuntime ?? null,
      };
    case 'artifact':
      return {
        ...base,
        kind: 'artifact',
        props: { memoId: tab.target.pointerMemoId },
      };
    case 'agent_conversation':
      return { ...base, kind: 'agent-conversation', instanceId: tab.target.instanceId };
  }
}

export function getBrowserColumnSurfaceDefinition(
  surface: BrowserColumnSurface,
): BrowserColumnSurfaceDefinition {
  return browserColumnSurfaceRegistry[surface.kind];
}

export function browserColumnSurfaceSupports(
  surface: BrowserColumnSurface,
  capability: BrowserColumnSurfaceCapability,
): boolean {
  return getBrowserColumnSurfaceDefinition(surface).capabilities.includes(capability);
}

export function BrowserColumnSurfaceHost({ surface }: { surface: BrowserColumnSurface }) {
  return (
    <BrowserColumnSurfaceMount
      key={`${surface.kind}:${surface.instanceKey}`}
      surface={surface}
    />
  );
}

function BrowserColumnSurfaceMount({ surface }: { surface: BrowserColumnSurface }) {
  return getBrowserColumnSurfaceDefinition(surface).render(surface);
}
