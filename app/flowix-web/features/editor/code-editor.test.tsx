import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodeEditor, type CodeEditorHandle } from '@features/editor/code-editor';

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
    expect(container.querySelector('.cm-content')?.textContent).toBe('hello');
    expect(onChange).not.toHaveBeenCalled();
  });
});
