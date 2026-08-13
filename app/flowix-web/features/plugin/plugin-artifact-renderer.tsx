'use client';

import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { Transformer } from 'markmap-lib';
import { Markmap } from 'markmap-view';

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
  const svgRef = useRef<SVGSVGElement>(null);
  const markmapRef = useRef<Markmap | null>(null);

  useImperativeHandle(rendererRef, () => ({
    fit: () => { void markmapRef.current?.fit(); },
    zoomIn: () => { void markmapRef.current?.rescale(1.2); },
    zoomOut: () => { void markmapRef.current?.rescale(0.8); },
  }), []);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.replaceChildren();
    const transformer = new Transformer();
    const { root } = transformer.transform(content);
    const markmap = Markmap.create(svg, { autoFit: true }, root);
    markmapRef.current = markmap;
    return () => {
      markmap.destroy();
      markmapRef.current = null;
      svg.replaceChildren();
    };
  }, [content]);

  return <svg ref={svgRef} className="h-full min-h-0 w-full" aria-label="Mind map" />;
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
