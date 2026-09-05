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
import { ArrowLeft, ArrowRight, ChevronLeft, Globe, RotateCw } from 'lucide-react';
import { LazyAgentConversationDetail } from '@features/agent/components/lazy-agent-conversation-detail';
import { DocumentContainer } from '@features/document/components/document-container';
import { FolderFileTree } from '@features/memo/components/folder-file-tree';
import {
  useBrowserColumnStore,
  type BrowserColumnTab,
  type BrowserColumnWebNavigationPhase,
  type BrowserColumnWebRuntime,
} from '@features/workspace/store/browser-column-store';
import { canonicalUrl } from '@features/workspace/store/workspace-content-identity';
import { Webview } from '@platform/tauri/webview';
import { getCurrentWindow } from '@platform/tauri/window';
import { LogicalPosition, LogicalSize } from '@platform/tauri/dpi';

const BROWSER_COLUMN_NAVIGATION_EVENT = 'flowix-browser-column-navigation';

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

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !isNativeTauri) return;

    const label = `browser-column-webpage-${++externalWebviewSequence}`;
    const currentWindow = getCurrentWindow();
    const getBounds = () => {
      const rect = viewport.getBoundingClientRect();
      return {
        x: Math.max(0, rect.left),
        y: Math.max(0, rect.top),
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height),
      };
    };

    let child: Webview | null = null;
    let disposed = false;
    let unlistenNavigation: (() => void) | null = null;
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
        if (disposed) {
          unlisten();
        } else {
          unlistenNavigation = unlisten;
        }
      }).catch(() => undefined);
      child = new Webview(currentWindow, label, { url: currentUrl, ...getBounds(), focus: false });
      void child.once('tauri://created', () => {
        if (!disposed) reportRuntime({ isLoading: false, error: null });
      });
      void child.once('tauri://error', (event) => {
        console.error('Failed to create browser-column webpage Webview', event);
        if (!disposed) reportRuntime({ isLoading: false, error: '网页视图创建失败' });
      });
      const syncBounds = () => {
        if (!child || disposed) return;
        const next = getBounds();
        void Promise.all([
          child.setPosition(new LogicalPosition(next.x, next.y)),
          child.setSize(new LogicalSize(next.width, next.height)),
        ]).catch(() => undefined);
      };
      const observer = new ResizeObserver(syncBounds);
      observer.observe(viewport);
      window.addEventListener('resize', syncBounds);
      return () => {
        disposed = true;
        unlistenNavigation?.();
        observer.disconnect();
        window.removeEventListener('resize', syncBounds);
        void child?.close().catch(() => undefined);
      };
    } catch (error) {
      console.error('Failed to initialize browser-column webpage Webview', error);
      reportRuntime({ isLoading: false, error: '网页视图初始化失败' });
    }
  }, [currentUrl, isNativeTauri, reloadToken, reportRuntime]);

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

function BrowserFileBrowserSurfaceView({ surface }: { surface: BrowserFileBrowserSurface }) {
  const selectFile = useBrowserColumnStore((state) => state.selectFileBrowserFile);
  const setTreeVisible = useBrowserColumnStore((state) => state.setFileBrowserTreeVisible);
  const setTreeWidth = useBrowserColumnStore((state) => state.setFileBrowserTreeWidth);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef({ x: 0, width: surface.fileTreeWidth });

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

  return (
    <div className="flex h-full min-w-0">
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
      {surface.fileTreeVisible ? (
        <div className="relative shrink-0 py-1 pr-1" style={{ width: surface.fileTreeWidth }}>
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
          <div className="h-full overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]">
            <FolderFileTree
              folderPath={surface.folderPath}
              folderName={surface.folderPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? surface.folderPath}
              embedded
              activeFilePath={surface.activeFilePath}
              onRequestClose={() => setTreeVisible(surface.tabId, false)}
              onFileSelect={(filePath) => selectFile(surface.tabId, filePath)}
            />
          </div>
        </div>
      ) : (
        <button
          type="button"
          aria-label="展开文件树"
          title="展开文件树"
          onClick={() => setTreeVisible(surface.tabId, true)}
          className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)] shadow-sm hover:text-[var(--foreground)]"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
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
): BrowserColumnSurface {
  const base = { instanceKey: `tab:${tab.id}`, tabId: tab.id };
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
