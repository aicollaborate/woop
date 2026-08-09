import type { EditorView } from '@tiptap/pm/view';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  calculateMobileViewportMetrics,
  scrollMobileEditorSelectionIntoView,
} from './mobile-editor-viewport';

describe('mobile editor viewport', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('calculates keyboard occlusion from layout height without subtracting iOS viewport pan', () => {
    expect(calculateMobileViewportMetrics({
      layoutViewportHeight: 874,
      visualViewportHeight: 539,
      visualViewportOffsetTop: 137,
      editorFocused: true,
    })).toEqual({
      top: 137,
      height: 539,
      bottom: 676,
      keyboardOcclusion: 335,
    });
  });

  it('does not reserve keyboard space for browser chrome changes or a blurred editor', () => {
    expect(calculateMobileViewportMetrics({
      layoutViewportHeight: 874,
      visualViewportHeight: 800,
      visualViewportOffsetTop: 0,
      editorFocused: true,
    }).keyboardOcclusion).toBe(0);

    expect(calculateMobileViewportMetrics({
      layoutViewportHeight: 874,
      visualViewportHeight: 539,
      visualViewportOffsetTop: 0,
      editorFocused: false,
    }).keyboardOcclusion).toBe(0);
  });

  it('scrolls the caret inside the editor and consumes ProseMirror body scrolling', () => {
    const topbar = document.createElement('header');
    topbar.className = 'mobile-document-topbar';
    const container = document.createElement('div');
    container.className = 'mobile-markdown-editor__content';
    const editor = document.createElement('div');
    container.appendChild(editor);
    const toolbar = document.createElement('div');
    toolbar.className = 'mobile-editor-toolbar is-visible';
    document.body.append(topbar, container, toolbar);

    topbar.getBoundingClientRect = vi.fn(() => ({
      top: 0, bottom: 58, left: 0, right: 390, width: 390, height: 58, x: 0, y: 0,
      toJSON: () => ({}),
    }));
    // The scroll viewport deliberately keeps its stable layout height and runs
    // behind the keyboard. The portalled toolbar, not a clipped container
    // bottom, defines the caret's visible lower edge.
    container.getBoundingClientRect = vi.fn(() => ({
      top: 58, bottom: 874, left: 0, right: 390, width: 390, height: 816, x: 0, y: 58,
      toJSON: () => ({}),
    }));
    toolbar.getBoundingClientRect = vi.fn(() => ({
      top: 469, bottom: 523, left: 10, right: 380, width: 370, height: 54, x: 10, y: 469,
      toJSON: () => ({}),
    }));
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);

    const view = {
      dom: editor,
      state: { selection: { head: 12 } },
      coordsAtPos: vi.fn(() => ({ top: 490, bottom: 512, left: 20, right: 20 })),
    } as unknown as EditorView;

    expect(scrollMobileEditorSelectionIntoView(view)).toBe(true);
    expect(container.scrollTop).toBe(55);
    expect(scrollBy).not.toHaveBeenCalled();
  });
});
