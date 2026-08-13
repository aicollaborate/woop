'use client';

import { useCallback, useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { Transformer } from 'markmap-lib';
import { Markmap } from 'markmap-view';

const MARKMAP_BRANCH_COLORS = [
  'var(--plugin-markmap-branch-1)',
  'var(--plugin-markmap-branch-2)',
  'var(--plugin-markmap-branch-3)',
  'var(--plugin-markmap-branch-4)',
];

export interface PluginArtifactRendererHandle {
  fit?: () => void;
  zoomIn?: () => void;
  zoomOut?: () => void;
}

type RendererProps = {
  content: string;
  rendererRef?: Ref<PluginArtifactRendererHandle>;
};

function MarkmapRenderer({ content, rendererRef }: RendererProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const markmapRef = useRef<Markmap | null>(null);

  const fit = useCallback(() => {
    void markmapRef.current?.fit();
  }, []);

  useImperativeHandle(rendererRef, () => ({
    fit,
    zoomIn: () => { void markmapRef.current?.rescale(1.2); },
    zoomOut: () => { void markmapRef.current?.rescale(0.8); },
  }), [fit]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.replaceChildren();
    const transformer = new Transformer();
    const { root } = transformer.transform(content);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const markmap = Markmap.create(svg, {
      autoFit: true,
      duration: reduceMotion ? 0 : 260,
      embedGlobalCSS: true,
      fitRatio: 0.88,
      initialExpandLevel: -1,
      maxInitialScale: 1.2,
      maxWidth: 360,
      nodeMinHeight: 24,
      paddingX: 12,
      pan: true,
      scrollForPan: false,
      spacingHorizontal: 92,
      spacingVertical: 10,
      toggleRecursively: false,
      zoom: true,
      color: (node) => MARKMAP_BRANCH_COLORS[node.state.depth % MARKMAP_BRANCH_COLORS.length],
      lineWidth: (node) => node.state.depth === 1 ? 2 : 1.4,
    }, root);
    markmapRef.current = markmap;
    const frame = requestAnimationFrame(fit);
    return () => {
      cancelAnimationFrame(frame);
      markmap.destroy();
      markmapRef.current = null;
      svg.replaceChildren();
    };
  }, [content, fit]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [fit]);

  return (
    <div ref={canvasRef} className="plugin-markmap-canvas">
      <svg ref={svgRef} className="plugin-markmap-canvas__svg markmap" role="img" aria-label="思维导图" />
    </div>
  );
}

function JsonRenderer({ content }: RendererProps) {
  let formatted = content;
  try {
    formatted = JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    // The backend validates JSON outputs; retain a readable fallback for old artifacts.
  }
  return <pre className="h-full overflow-auto whitespace-pre-wrap p-6 text-sm">{formatted}</pre>;
}

function HtmlRenderer({ content }: RendererProps) {
  return (
    <iframe
      title="Plugin HTML output"
      className="h-full w-full border-0 bg-white"
      sandbox=""
      srcDoc={content}
    />
  );
}

function TextRenderer({ content }: RendererProps) {
  return <pre className="h-full overflow-auto whitespace-pre-wrap p-6 text-sm">{content}</pre>;
}

export const PluginArtifactRenderer = ({
  renderer,
  content,
  rendererRef,
}: {
  renderer: string;
  content: string;
  rendererRef?: Ref<PluginArtifactRendererHandle>;
}) => {
  if (renderer === 'markmap') {
    return <MarkmapRenderer content={content} rendererRef={rendererRef} />;
  }
  if (renderer === 'json-viewer') {
    return <JsonRenderer content={content} rendererRef={rendererRef} />;
  }
  if (renderer === 'html') {
    return <HtmlRenderer content={content} rendererRef={rendererRef} />;
  }
  return <TextRenderer content={content} rendererRef={rendererRef} />;
};
