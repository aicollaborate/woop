import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 捕获 MobileRichMarkdownEditor 的 onChange, 让测试无需拉起 Tiptap 即可驱动
// 文档正文变更。vi.hoisted 保证 mock 工厂能引用到 holder。
const editor = vi.hoisted(() => ({
  trigger: null as null | ((body: string) => void),
  content: null as string | null,
}));

const writeDocument = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock('@features/editor/mobile/mobile-rich-markdown-editor', () => ({
  MobileRichMarkdownEditor: ({ content, onChange }: { content: string; onChange: (body: string) => void }) => {
    editor.trigger = onChange;
    editor.content = content;
    return null;
  },
}));

vi.mock('@platform/tauri/mobile-client', () => ({
  mobileClient: {
    memos: { writeDocument: writeDocument.fn },
  },
}));

import { MobileDocumentScreen } from './mobile-document-screen';

interface WriteResult {
  path: string;
  content: string;
}

interface Rendered {
  container: HTMLDivElement;
  root: Root;
  onBack: ReturnType<typeof vi.fn>;
}

async function renderScreen(props: {
  memoId?: string;
  content?: string;
  onBack?: () => void;
}): Promise<Rendered> {
  const onBack = vi.fn(props.onBack ?? (() => undefined));
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(MobileDocumentScreen, {
        memoId: props.memoId ?? 'm1',
        filename: 'note.md',
        content: props.content ?? '# Hello',
        onBack,
      }),
    );
  });
  return { container, root, onBack };
}

function saveStatus(container: HTMLElement): string {
  const node = container.querySelector('.mobile-save-status');
  if (!node) return 'absent';
  const matched = node.className.match(/mobile-save-status--(\S+)/);
  return matched ? matched[1] : 'unknown';
}

// 等过 800ms 防抖 + 让 writeDocument 的 Promise 链落定。
const waitForDebounce = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 850));

// 排空微任务队列 (handleBack -> saveLatest -> writeDocument -> onBack 链)。
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('MobileDocumentScreen · save state machine', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onBack: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    editor.trigger = null;
    editor.content = null;
    // 默认成功: 返回调用方传入的 content (磁盘最终内容)。
    writeDocument.fn.mockImplementation(
      (params: { content: string }) =>
        Promise.resolve({ path: '/n/nb1/note.md', content: params.content } as WriteResult),
    );
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    window.localStorage.clear();
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    vi.useRealTimers();
  });

  it('auto-saves the joined document after the debounce with the prior content as expected', async () => {
    const content = '---\nkey: m1\ntags: []\n---\n# Hello';
    ({ container, root, onBack } = await renderScreen({ content }));
    expect(editor.trigger).not.toBeNull();

    await act(async () => {
      editor.trigger?.('# Hello world');
    });
    // 还没过防抖 -> 仍 dirty, writeDocument 未触发。
    expect(writeDocument.fn).not.toHaveBeenCalled();
    expect(saveStatus(container)).toBe('dirty');

    await act(async () => { await waitForDebounce(); });

    expect(writeDocument.fn).toHaveBeenCalledOnce();
    expect(writeDocument.fn).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'm1',
        // frontmatter 被原样拼回, 只换 body。
        content: '---\nkey: m1\ntags: []\n---\n# Hello world',
        // expectedContent = 上一次落盘的完整内容。
        expectedContent: content,
      }),
    );
    expect(saveStatus(container)).toBe('saved');
  });

  it('recovers a same-revision local draft and persists it automatically', async () => {
    window.localStorage.setItem('flowix:mobile-draft:m1', JSON.stringify({
      baseContent: '# Hello',
      content: '# Recovered draft',
    }));
    ({ container, root, onBack } = await renderScreen({ content: '# Hello' }));

    expect(editor.content).toBe('# Recovered draft');
    expect(saveStatus(container)).toBe('dirty');
    await act(async () => { await waitForDebounce(); });

    expect(writeDocument.fn).toHaveBeenCalledWith(expect.objectContaining({
      content: '# Recovered draft',
      expectedContent: '# Hello',
    }));
    expect(window.localStorage.getItem('flowix:mobile-draft:m1')).toBeNull();
  });

  it('does not apply a stale or malformed draft over a newer disk revision', async () => {
    window.localStorage.setItem('flowix:mobile-draft:m1', JSON.stringify({
      baseContent: '# Old revision',
      content: '# Stale draft',
    }));
    ({ container, root, onBack } = await renderScreen({ content: '# Current revision' }));

    expect(editor.content).toBe('# Current revision');
    expect(saveStatus(container)).toBe('saved');
    expect(writeDocument.fn).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    const malformedContainer = document.createElement('div');
    document.body.replaceChildren(malformedContainer);
    window.localStorage.setItem('flowix:mobile-draft:m1', '{not valid json');
    const malformedRoot = createRoot(malformedContainer);
    root = malformedRoot;
    await act(async () => {
      root.render(createElement(MobileDocumentScreen, {
        memoId: 'm1', filename: 'note.md', content: '# Current revision', onBack: () => undefined,
      }));
    });
    expect(editor.content).toBe('# Current revision');
    expect(writeDocument.fn).not.toHaveBeenCalled();
  });

  it('coalesces rapid edits into a single write of the final body', async () => {
    ({ container, root, onBack } = await renderScreen({ content: '# Hello' }));

    await act(async () => {
      editor.trigger?.('# A');
      editor.trigger?.('# AB');
      editor.trigger?.('# ABC');
    });
    expect(writeDocument.fn).not.toHaveBeenCalled();

    await act(async () => { await waitForDebounce(); });

    expect(writeDocument.fn).toHaveBeenCalledOnce();
    expect(writeDocument.fn).toHaveBeenCalledWith(
      expect.objectContaining({ content: '# ABC', expectedContent: '# Hello' }),
    );
  });

  it('marks conflict when the CAS write returns null', async () => {
    writeDocument.fn.mockResolvedValue(null);
    ({ container, root, onBack } = await renderScreen({ content: '# Hello' }));

    await act(async () => { editor.trigger?.('# changed'); });
    await act(async () => { await waitForDebounce(); });

    expect(writeDocument.fn).toHaveBeenCalledOnce();
    expect(saveStatus(container)).toBe('conflict');
  });

  it('marks error when the write rejects', async () => {
    writeDocument.fn.mockRejectedValue(new Error('磁盘满'));
    ({ container, root, onBack } = await renderScreen({ content: '# Hello' }));

    await act(async () => { editor.trigger?.('# changed'); });
    await act(async () => { await waitForDebounce(); });

    expect(writeDocument.fn).toHaveBeenCalledOnce();
    expect(saveStatus(container)).toBe('error');
  });

  it('keeps the draft after a failed write so it can be recovered on next launch', async () => {
    writeDocument.fn.mockRejectedValue(new Error('磁盘满'));
    ({ container, root, onBack } = await renderScreen({ content: '# Hello' }));

    await act(async () => { editor.trigger?.('# unsaved'); });
    await act(async () => { await waitForDebounce(); });

    expect(saveStatus(container)).toBe('error');
    expect(JSON.parse(window.localStorage.getItem('flowix:mobile-draft:m1') || '{}')).toEqual({
      baseContent: '# Hello',
      content: '# unsaved',
    });
  });

  it('flushes a pending save immediately when the app is backgrounded', async () => {
    ({ container, root, onBack } = await renderScreen({ content: '# Hello' }));

    await act(async () => { editor.trigger?.('# changed'); });
    expect(writeDocument.fn).not.toHaveBeenCalled();

    // 模拟切到后台: visibilitychange + document.hidden = true。
    // 组件清掉防抖定时器并立刻 saveLatest。
    await act(async () => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
      await flush();
    });

    expect(writeDocument.fn).toHaveBeenCalledOnce();
    expect(saveStatus(container)).toBe('saved');
  });

  it('flushes pending save on system back, then calls onBack', async () => {
    ({ container, root, onBack } = await renderScreen({ content: '# Hello' }));

    await act(async () => { editor.trigger?.('# changed'); });
    expect(writeDocument.fn).not.toHaveBeenCalled();

    // 模拟系统返回键: 组件 mount 时 pushState, popstate 触发 handleBack。
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'));
      await flush();
    });

    expect(writeDocument.fn).toHaveBeenCalledOnce();
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('keeps the editor open when saving on Back detects a conflict', async () => {
    writeDocument.fn.mockResolvedValue(null);
    ({ container, root, onBack } = await renderScreen({ content: '# Hello' }));

    await act(async () => { editor.trigger?.('# changed'); });
    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'));
      await flush();
    });

    expect(writeDocument.fn).toHaveBeenCalledOnce();
    expect(saveStatus(container)).toBe('conflict');
    expect(onBack).not.toHaveBeenCalled();
  });

  it('waits for an in-flight save and persists newer edits before leaving', async () => {
    let finishFirstSave: ((result: WriteResult) => void) | null = null;
    writeDocument.fn
      .mockImplementationOnce(() => new Promise<WriteResult>((resolve) => { finishFirstSave = resolve; }))
      .mockImplementation((params: { content: string }) => Promise.resolve({
        path: '/n/nb1/note.md',
        content: params.content,
      } as WriteResult));
    ({ container, root, onBack } = await renderScreen({ content: '# Hello' }));

    await act(async () => { editor.trigger?.('# first'); });
    await act(async () => { await waitForDebounce(); });
    expect(writeDocument.fn).toHaveBeenCalledOnce();

    await act(async () => {
      editor.trigger?.('# latest');
      window.dispatchEvent(new PopStateEvent('popstate'));
      finishFirstSave?.({ path: '/n/nb1/note.md', content: '# first' });
      await flush();
      await flush();
    });

    expect(writeDocument.fn).toHaveBeenCalledTimes(2);
    expect(writeDocument.fn).toHaveBeenLastCalledWith(expect.objectContaining({
      content: '# latest',
      expectedContent: '# first',
    }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('calls onBack without writing when there are no pending edits', async () => {
    ({ container, root, onBack } = await renderScreen({ content: '# Hello' }));

    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate'));
      await flush();
    });

    expect(writeDocument.fn).not.toHaveBeenCalled();
    expect(onBack).toHaveBeenCalledOnce();
  });
});
