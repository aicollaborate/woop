import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PluginMarkmapControls } from './plugin-markmap-controls';

let container: HTMLDivElement;
let root: Root;
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe('PluginMarkmapControls', () => {
  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('keeps the reference control order and forwards every action', async () => {
    const onZoomOut = vi.fn();
    const onFit = vi.fn();
    const onZoomIn = vi.fn();
    const onOpenArtifact = vi.fn();
    const onToggleFullscreen = vi.fn();

    await act(async () => root.render(createElement(PluginMarkmapControls, {
      fullscreen: false,
      onZoomOut,
      onFit,
      onZoomIn,
      onOpenArtifact,
      onToggleFullscreen,
    })));

    const toolbar = container.querySelector('[role="toolbar"]');
    const buttons = Array.from(toolbar?.querySelectorAll('button') ?? []);
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      '缩小',
      '适配画布',
      '放大',
      '打开产物',
      '全屏',
    ]);

    await act(async () => buttons.forEach((button) => button.click()));
    expect(onZoomOut).toHaveBeenCalledOnce();
    expect(onFit).toHaveBeenCalledOnce();
    expect(onZoomIn).toHaveBeenCalledOnce();
    expect(onOpenArtifact).toHaveBeenCalledOnce();
    expect(onToggleFullscreen).toHaveBeenCalledOnce();
  });
});
