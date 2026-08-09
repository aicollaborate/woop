import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const documentScreen = vi.hoisted(() => ({
  props: null as null | {
    onBack: () => void;
    onBackRejected: () => void;
  },
}));

vi.mock('./mobile-document-screen', () => ({
  MobileDocumentScreen: (props: NonNullable<typeof documentScreen.props>) => {
    documentScreen.props = props;
    return null;
  },
}));

vi.mock('./mobile-navigation-drawer', () => ({
  MobileNavigationDrawer: (props: { onAccount: () => void }) => createElement(
    'div',
    { className: 'mobile-drawer-test' },
    createElement('button', { type: 'button', onClick: props.onAccount }, '个人'),
  ),
}));

vi.mock('./mobile-account-panel', () => ({
  MobileAccountPanel: () => createElement('div', { className: 'mobile-account-panel-test' }, '账号与云同步'),
}));

import { MobileApp } from './mobile-app';

let library: Record<string, unknown>;

vi.mock('./use-mobile-library', () => ({
  useMobileLibrary: () => library,
}));

vi.mock('./mobile-memo-list', () => ({
  MobileMemoList: () => null,
}));

let container: HTMLDivElement;
let root: Root;

function dispatchPointer(target: Element, type: string, x: number): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: 0,
    clientX: x,
    clientY: 120,
  });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: 'touch' },
  });
  target.dispatchEvent(event);
}

describe('MobileApp', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    documentScreen.props = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    library = {
      activeDocument: null,
      booting: false,
      canSync: false,
      createMemo: vi.fn(),
      dismissMessage: vi.fn(),
      loadingList: false,
      memoItems: [],
      message: '同步失败，请重试。',
      selectedNotebook: null,
      selectedNotebookId: null,
      selectedTag: null,
      searchMemos: vi.fn(),
      syncing: false,
      syncNow: vi.fn(),
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('dismisses a list message after four seconds', async () => {
    await act(async () => root.render(createElement(MobileApp)));

    expect(container.textContent).toContain('同步失败，请重试。');
    await act(async () => { vi.advanceTimersByTime(3_999); });
    expect(library.dismissMessage).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(1); });
    expect(library.dismissMessage).toHaveBeenCalledOnce();
  });

  it('uses one cloud SVG with a state-specific status mark', async () => {
    library.message = '';
    await act(async () => root.render(createElement(MobileApp)));
    expect(container.querySelector('.mobile-cloud-status-icon--unlinked')).not.toBeNull();

    library.canSync = true;
    await act(async () => root.render(createElement(MobileApp)));
    expect(container.querySelector('.mobile-cloud-status-icon--connected')).not.toBeNull();

    library.syncing = true;
    await act(async () => root.render(createElement(MobileApp)));
    expect(container.querySelector('.mobile-cloud-status-icon--connecting')).not.toBeNull();
  });

  it('opens the account sheet above the navigation drawer', async () => {
    library.message = '';
    await act(async () => root.render(createElement(MobileApp)));

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="打开导航"]')?.click());
    expect(container.querySelector('.mobile-drawer-test')).not.toBeNull();

    await act(async () => container.querySelector<HTMLButtonElement>('.mobile-drawer-test button')?.click());
    await act(async () => { await Promise.resolve(); });

    expect(container.querySelector('.mobile-drawer-test')).not.toBeNull();
    expect(container.querySelector('.mobile-account-panel-test')).not.toBeNull();
    expect(window.history.state).toEqual(expect.objectContaining({
      flowixMobileLayer: 'account',
      parent: 'drawer',
    }));
  });

  it('expands search and waits briefly before querying', async () => {
    library.message = '';
    const searchMemos = vi.fn();
    library.searchMemos = searchMemos;
    await act(async () => root.render(createElement(MobileApp)));

    const searchButton = container.querySelector<HTMLButtonElement>('[aria-label="搜索笔记"]');
    await act(async () => searchButton?.click());
    expect(container.querySelector('.mobile-list-topbar')?.classList.contains('is-search-open')).toBe(true);

    const input = container.querySelector<HTMLInputElement>('input[type="search"]');
    expect(input).not.toBeNull();
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    valueSetter?.call(input, '全文关键词');
    await act(async () => input?.dispatchEvent(new Event('input', { bubbles: true })));
    expect(searchMemos).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(140); });
    expect(searchMemos).toHaveBeenCalledWith('全文关键词');
  });

  async function renderOpenDocument() {
    const closeDocument = vi.fn(() => {
      library.openingMemo = null;
      library.activeDocument = null;
    });
    library = {
      ...library,
      activeDocument: {
        memo: { id: 'm1', filename: 'note.md' },
        content: '# Note',
      },
      closeDocument,
      message: '',
      openingMemo: { id: 'm1', filename: 'note.md' },
    };
    await act(async () => root.render(createElement(MobileApp)));
    const layer = container.querySelector('.mobile-document-layer');
    expect(layer).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(368));
    expect(layer?.getAttribute('data-motion')).toBe('steady');
    expect(documentScreen.props).not.toBeNull();
    return { closeDocument, layer: layer! };
  }

  async function commitDocumentSwipe(layer: Element) {
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    await act(async () => dispatchPointer(layer, 'pointerdown', 4));
    await act(async () => dispatchPointer(layer, 'pointermove', 520));
    await act(async () => dispatchPointer(layer, 'pointerup', 520));
    expect(historyBack).toHaveBeenCalledOnce();
    expect(layer.getAttribute('data-motion')).toBe('swipe-closing');
    return historyBack;
  }

  it('unmounts directly after a committed swipe and a successful save', async () => {
    const { closeDocument, layer } = await renderOpenDocument();
    await commitDocumentSwipe(layer);

    await act(async () => documentScreen.props?.onBack());
    expect(closeDocument).not.toHaveBeenCalled();
    expect(layer.classList.contains('mobile-document-layer--exit')).toBe(false);

    await act(async () => vi.advanceTimersByTime(328));
    expect(closeDocument).toHaveBeenCalledOnce();
    expect(container.querySelector('.mobile-document-layer')).toBeNull();
  });

  it('restores the document layer when saving a swipe-back is rejected', async () => {
    const { closeDocument, layer } = await renderOpenDocument();
    await commitDocumentSwipe(layer);

    await act(async () => documentScreen.props?.onBackRejected());
    expect(layer.getAttribute('data-motion')).toBe('swipe-restoring');
    expect((layer as HTMLElement).style.transform).toBe('translate3d(0px, 0, 0)');

    await act(async () => vi.advanceTimersByTime(328));
    expect(layer.getAttribute('data-motion')).toBe('steady');
    expect(closeDocument).not.toHaveBeenCalled();
  });

  it('keeps one exit animation for a non-swipe Back', async () => {
    const { closeDocument, layer } = await renderOpenDocument();

    await act(async () => documentScreen.props?.onBack());
    expect(layer.getAttribute('data-motion')).toBe('exit-closing');
    expect(layer.classList.contains('mobile-document-layer--exit')).toBe(true);
    expect(closeDocument).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTime(368));
    expect(closeDocument).toHaveBeenCalledOnce();
    expect(container.querySelector('.mobile-document-layer')).toBeNull();
  });

  it('keeps the document layer actionable when opening fails', async () => {
    const openMemo = vi.fn();
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    library = {
      ...library,
      activeDocument: null,
      closeDocument: vi.fn(),
      message: '',
      openMemo,
      openMemoError: {
        id: 'm1',
        filename: 'note.md',
        kind: 'failed',
        message: '文件权限已撤销',
      },
      openingMemo: { id: 'm1', filename: 'note.md' },
    };

    await act(async () => root.render(createElement(MobileApp)));
    expect(container.querySelector('.mobile-document-layer')).not.toBeNull();

    library = {
      ...library,
      openingMemo: null,
    };
    await act(async () => root.render(createElement(MobileApp)));

    expect(container.querySelector('.mobile-document-layer')).not.toBeNull();
    expect(container.textContent).toContain('无法打开笔记');
    expect(container.textContent).toContain('文件权限已撤销');

    await act(async () => container.querySelector<HTMLButtonElement>('.mobile-document-state-primary')?.click());
    expect(openMemo).toHaveBeenCalledWith('m1');

    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="返回列表"]')?.click());
    expect(historyBack).toHaveBeenCalled();
  });
});
