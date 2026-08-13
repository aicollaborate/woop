'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowsInIcon,
  CornersInIcon,
  CornersOutIcon,
  MinusIcon,
  PlusIcon,
  ArrowClockwiseIcon,
} from '@phosphor-icons/react';
import { plugins, type PluginArtifact } from '@platform/tauri/client';
import { useDocumentStore } from '@features/document';
import { PluginArtifactRenderer, type PluginArtifactRendererHandle } from './plugin-artifact-renderer';

export function PluginDocumentView({
  memoId,
  transitionId,
}: {
  memoId: string;
  transitionId?: number;
}) {
  const [artifact, setArtifact] = useState<PluginArtifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<PluginArtifactRendererHandle>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setArtifact(await plugins.resolveNote(memoId));
    } catch (loadError) {
      setArtifact(null);
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      // Plugin pointer notes bypass DocumentContainer, which normally owns
      // the document transition completion callback. Complete the same
      // transition after the pointer/artifact has been resolved, otherwise
      // MainLayout's document loading overlay remains visible forever.
      if (transitionId !== undefined) {
        useDocumentStore.getState().finishDocumentTransition(transitionId);
      }
    }
  }, [memoId, transitionId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onFullscreenChange = () => setFullscreen(document.fullscreenElement === canvasRef.current);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const toggleFullscreen = async () => {
    if (!canvasRef.current) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await canvasRef.current.requestFullscreen();
  };

  if (error) {
    return <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-sm text-[var(--muted-foreground)]">
      <p>插件产物无法加载：{error}</p>
      <button className="inline-flex items-center gap-2 rounded-lg border px-3 py-2" onClick={() => void load()}><ArrowClockwiseIcon size={16} weight="bold" />重试</button>
    </div>;
  }
  if (!artifact) return <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">正在加载插件产物…</div>;

  return <div ref={canvasRef} className="relative flex h-full min-w-0 flex-col overflow-hidden bg-[var(--document-bg)] [&:fullscreen]:h-screen">
    <div className="absolute left-4 right-4 top-4 z-20 flex justify-end pointer-events-none">
      <div className="pointer-events-auto flex items-center gap-1 rounded-xl border border-[var(--divider)] bg-[var(--card)]/90 p-1 shadow-lg backdrop-blur">
        {artifact.renderer === 'markmap' && <>
          <button className="rounded-lg p-2 hover:bg-[var(--muted)]" onClick={() => rendererRef.current?.fit?.()} title="适配画布" aria-label="适配画布"><ArrowsInIcon size={16} weight="bold" /></button>
          <button className="rounded-lg p-2 hover:bg-[var(--muted)]" onClick={() => rendererRef.current?.zoomIn?.()} title="放大" aria-label="放大"><PlusIcon size={16} weight="bold" /></button>
          <button className="rounded-lg p-2 hover:bg-[var(--muted)]" onClick={() => rendererRef.current?.zoomOut?.()} title="缩小" aria-label="缩小"><MinusIcon size={16} weight="bold" /></button>
        </>}
        <button className="rounded-lg p-2 hover:bg-[var(--muted)]" onClick={() => void toggleFullscreen()} title={fullscreen ? '退出全屏' : '全屏'} aria-label={fullscreen ? '退出全屏' : '全屏'}>{fullscreen ? <CornersInIcon size={16} weight="bold" /> : <CornersOutIcon size={16} weight="bold" />}</button>
      </div>
    </div>
    <div className="min-h-0 flex-1 overflow-hidden"><PluginArtifactRenderer rendererRef={rendererRef} renderer={artifact.renderer} content={artifact.content ?? ''} /></div>
  </div>;
}
