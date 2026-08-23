import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodeEditor, type CodeEditorHandle } from '@features/editor/code-editor';

vi.mock(
  '@features/editor/extensions/codeblock-shiki/shiki/shiki-highlighter',
  () => ({
    getShiki: () => ({
      codeToTokensBase: (code: string) =>
        code.split('\n').map((line) =>
          line ? [{ content: line, color: '#123456' }] : []
        ),
      getLoadedThemes: () => ['github-light'],
      getLoadedLanguages: () => [
        'javascript',
        'typescript',
        'jsx',
        'tsx',
        'markdown',
        'python',
      ],
    }),
    loadLanguage: () => Promise.resolve(true),
  }),
);

let container: HTMLDivElement;
let root: Root;
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe('CodeEditor', () => {
  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('renders text content and synchronizes authoritative content without emitting an edit', async () => {
    const editorRef = createRef<CodeEditorHandle>();
    const onChange = vi.fn();

    await act(async () => root.render(
      <CodeEditor
        ref={editorRef}
        filePath="/project/empty.txt"
        content=""
        onChange={onChange}
      />
    ));

    expect(container.querySelector('.cm-editor')).not.toBeNull();
    expect(editorRef.current?.flushPendingChanges()).toBe('');

    await act(async () => root.render(
      <CodeEditor
        ref={editorRef}
        filePath="/project/empty.txt"
        content={'hello\n'}
        onChange={onChange}
      />
    ));

    expect(editorRef.current?.flushPendingChanges()).toBe('hello\n');
    const content = container.querySelector('.cm-content');
    expect(content?.textContent).toBe('hello');
    expect(content?.classList.contains('cm-lineWrapping')).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('colors supported languages through Shiki inline styles', async () => {
    await act(async () => root.render(
      <CodeEditor
        filePath="/project/example.js"
        content={'const answer = "yes";'}
        onChange={vi.fn()}
      />
    ));

    await act(async () => {
      await vi.waitFor(() => {
        // #123456 is serialized by the DOM as rgb(18, 52, 86).
        const colored = Array.from(container.querySelectorAll<HTMLSpanElement>('.cm-content span'))
          .find((el) => el.style.color === 'rgb(18, 52, 86)');
        expect(colored?.textContent).toBe('const answer = "yes";');
      });
    });
  });

  it('falls back to stable tagHighlighter classes for unsupported languages', async () => {
    await act(async () => root.render(
      <CodeEditor
        filePath="/project/example.pl"
        content={'if ($x) { print "yes"; }'}
        onChange={vi.fn()}
      />
    ));

    await act(async () => {
      await vi.waitFor(() => {
        expect(container.querySelector('.cm-code-keyword')?.textContent).toBe('if');
        expect(container.querySelector('.cm-code-string')?.textContent).toBe('"yes"');
      });
    });
  });
});
