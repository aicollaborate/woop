import type { EditorView } from '@tiptap/pm/view';

export const MOBILE_EDITOR_VIEWPORT_CHANGE_EVENT = 'flowix:mobile-editor-viewport-change';

const KEYBOARD_OCCLUSION_THRESHOLD = 96;
const CARET_EDGE_GAP = 12;

interface MobileViewportMetricsInput {
  layoutViewportHeight: number;
  visualViewportHeight: number;
  visualViewportOffsetTop: number;
  editorFocused: boolean;
}

export interface MobileViewportMetrics {
  top: number;
  height: number;
  bottom: number;
  keyboardOcclusion: number;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Describe the complete visual viewport while keeping keyboard occlusion tied
 * to the stable layout viewport. iOS changes offsetTop when it pans to a caret;
 * that pan must not be mistaken for a smaller keyboard.
 */
export function calculateMobileViewportMetrics({
  layoutViewportHeight,
  visualViewportHeight,
  visualViewportOffsetTop,
  editorFocused,
}: MobileViewportMetricsInput): MobileViewportMetrics {
  const layoutHeight = finiteNonNegative(layoutViewportHeight);
  const height = finiteNonNegative(visualViewportHeight);
  const top = finiteNonNegative(visualViewportOffsetTop);
  const occlusion = Math.max(0, layoutHeight - height);

  return {
    top,
    height,
    bottom: top + height,
    keyboardOcclusion:
      editorFocused && occlusion > KEYBOARD_OCCLUSION_THRESHOLD ? occlusion : 0,
  };
}

/**
 * Keep ProseMirror's selection inside the editor's own scroll container.
 * Returning true is important: it prevents ProseMirror's default fallback
 * from reaching document.body and calling window.scrollBy on iOS.
 */
export function scrollMobileEditorSelectionIntoView(view: EditorView): boolean {
  const scrollContainer = view.dom.closest<HTMLElement>('.mobile-markdown-editor__content');
  if (!scrollContainer) return true;

  let caretRect: ReturnType<EditorView['coordsAtPos']>;
  try {
    caretRect = view.coordsAtPos(view.state.selection.head, 1);
  } catch {
    return true;
  }

  const containerRect = scrollContainer.getBoundingClientRect();
  const topbarRect = document
    .querySelector<HTMLElement>('.mobile-document-topbar')
    ?.getBoundingClientRect();
  const toolbarRect = document
    .querySelector<HTMLElement>('.mobile-editor-toolbar.is-visible')
    ?.getBoundingClientRect();

  const visibleTop = Math.max(containerRect.top, topbarRect?.bottom ?? containerRect.top)
    + CARET_EDGE_GAP;
  const visibleBottom = Math.min(containerRect.bottom, toolbarRect?.top ?? containerRect.bottom)
    - CARET_EDGE_GAP;

  if (visibleBottom <= visibleTop) return true;

  if (caretRect.bottom > visibleBottom) {
    scrollContainer.scrollTop += caretRect.bottom - visibleBottom;
  } else if (caretRect.top < visibleTop) {
    scrollContainer.scrollTop -= visibleTop - caretRect.top;
  }

  return true;
}
