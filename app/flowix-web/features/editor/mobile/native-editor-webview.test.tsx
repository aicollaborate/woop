import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  mounts: 0,
  unmounts: 0,
  props: null as null | {
    memoId: string;
    externalContent?: { value: string; emitUpdate: boolean; token: number };
    onChange: (markdown: string) => void;
    onEditorReady: (editor: unknown) => void;
  },
}));

vi.mock('./mobile-rich-markdown-editor', () => ({
  MobileRichMarkdownEditor: (props: NonNullable<typeof harness.props>) => {
    harness.props = props;
    useEffect(() => {
      harness.mounts += 1;
      props.onEditorReady({
        isDestroyed: false,
        isFocused: false,
        isActive: () => false,
        view: { dom: { closest: () => null } },
        on: vi.fn(),
        off: vi.fn(),
      });
      return () => { harness.unmounts += 1; };
    }, []);
    return null;
  },
}));

import { NativeEditorWebViewApp } from './native-editor-webview';

describe('NativeEditorWebViewApp', () => {
  let container: HTMLDivElement;
  let root: Root;
  const bridgeEvents: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    harness.mounts = 0;
    harness.unmounts = 0;
    harness.props = null;
    bridgeEvents.length = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    Object.defineProperty(window, 'webkit', {
      configurable: true,
      value: { messageHandlers: { flowixEditor: { postMessage: (event: Record<string, unknown>) => bridgeEvents.push(event) } } },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    Reflect.deleteProperty(window, 'webkit');
  });

  it('applies the first native note without destroying the mounted Tiptap editor', async () => {
    await act(async () => root.render(createElement(NativeEditorWebViewApp)));
    expect(harness.mounts).toBe(1);

    await act(async () => {
      window.dispatchEvent(new CustomEvent('flowix-editor-command', {
        detail: { type: 'setContent', memoId: 'memo-20260813', content: '# 今日笔记' },
      }));
    });

    expect(harness.mounts).toBe(1);
    expect(harness.unmounts).toBe(0);
    expect(harness.props?.memoId).toBe('memo-20260813');
    expect(harness.props?.externalContent?.value).toBe('# 今日笔记');

    await act(async () => harness.props?.onChange('修改后的正文'));
    expect(bridgeEvents).toContainEqual({
      type: 'changed',
      memoId: 'memo-20260813',
      markdown: '修改后的正文',
    });
  });
});
