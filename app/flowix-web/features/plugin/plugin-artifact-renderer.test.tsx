import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginArtifactRenderer, type PluginArtifactRendererHandle } from './plugin-artifact-renderer';

const markmapMocks = vi.hoisted(() => ({
  create: vi.fn(),
  destroy: vi.fn(),
  fit: vi.fn(),
  rescale: vi.fn(),
  transform: vi.fn().mockReturnValue({ root: { content: 'root' } }),
}));

vi.mock('markmap-lib', () => ({
  Transformer: class {
    transform = markmapMocks.transform;
  },
}));

vi.mock('markmap-view', () => ({
  Markmap: {
    create: markmapMocks.create,
  },
}));

let container: HTMLDivElement;
let root: Root;
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe('PluginArtifactRenderer markmap canvas', () => {
  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    markmapMocks.create.mockReturnValue({
      destroy: markmapMocks.destroy,
      fit: markmapMocks.fit,
      rescale: markmapMocks.rescale,
    });
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
    vi.stubGlobal('requestAnimationFrame', vi.fn().mockReturnValue(1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('ResizeObserver', class {
      observe = vi.fn();
      disconnect = vi.fn();
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('uses the themed reading layout and exposes canvas controls', async () => {
    const rendererRef = createRef<PluginArtifactRendererHandle>();
    await act(async () => root.render(createElement(PluginArtifactRenderer, {
      renderer: 'markmap',
      content: '# Flowix\n## Canvas',
      rendererRef,
    })));

    expect(markmapMocks.transform).toHaveBeenCalledWith('# Flowix\n## Canvas');
    expect(markmapMocks.create).toHaveBeenCalledOnce();
    const [, options, data] = markmapMocks.create.mock.calls[0];
    expect(data).toEqual({ content: 'root' });
    expect(options).toMatchObject({
      autoFit: true,
      duration: 260,
      fitRatio: 0.88,
      maxInitialScale: 1.2,
      maxWidth: 360,
      spacingHorizontal: 92,
      spacingVertical: 10,
    });
    expect(options.color({ state: { depth: 1 } })).toBe('var(--plugin-markmap-branch-2)');
    expect(options.lineWidth({ state: { depth: 1 } })).toBe(2);
    expect(container.querySelector('.plugin-markmap-canvas__svg')).not.toBeNull();
    expect(container.querySelector('.plugin-markmap-canvas__hint')).toBeNull();

    rendererRef.current?.fit?.();
    rendererRef.current?.zoomIn?.();
    rendererRef.current?.zoomOut?.();
    expect(markmapMocks.fit).toHaveBeenCalledOnce();
    expect(markmapMocks.rescale).toHaveBeenNthCalledWith(1, 1.2);
    expect(markmapMocks.rescale).toHaveBeenNthCalledWith(2, 0.8);
  });
});
