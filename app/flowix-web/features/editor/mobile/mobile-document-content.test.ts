import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';

import { joinMobileDocumentContent, splitMobileDocumentContent } from './mobile-document-content';
import { parseStaticCustomBlockAttrs, tokenizeStaticCustomBlock, StaticCustomBlock } from './static-custom-block';

describe('mobile document content', () => {
  it('preserves frontmatter byte-for-byte while exposing only the body', () => {
    const content = '---\nkey: abc123\ntags:\n  - AI\n---\n# Title\nBody';
    const parts = splitMobileDocumentContent(content);
    expect(parts.frontmatter).toBe('---\nkey: abc123\ntags:\n  - AI\n---\n');
    expect(parts.body).toBe('# Title\nBody');
    expect(joinMobileDocumentContent(parts)).toBe(content);
  });

  it('keeps documents without frontmatter untouched', () => {
    const content = '# Plain\nText';
    expect(splitMobileDocumentContent(content)).toEqual({ frontmatter: '', body: content });
  });
});

describe('static custom block codec', () => {
  it('captures the exact agent thread markdown', () => {
    const source = '::agent-thread-card{threadId="t1" title="Plan" agentType="codex"}\nnext';
    const token = tokenizeStaticCustomBlock(source);
    expect(token?.raw).toBe('::agent-thread-card{threadId="t1" title="Plan" agentType="codex"}\n');
    expect(token?.kind).toBe('agent-thread-card');
    expect(parseStaticCustomBlockAttrs(token?.attrsSource ?? '')).toMatchObject({
      threadId: 't1',
      title: 'Plan',
      agentType: 'codex',
    });
  });

  it('round-trips a static block and rejects a transaction that deletes it', () => {
    const raw = '::agent-thread-card{threadId="t1" title="Plan" agentType="codex"}\n';
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [
        StarterKit.configure({ heading: { levels: [1, 2, 3, 4] } }),
        StaticCustomBlock,
        Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
      ],
      content: `# Before\n\n${raw}\nAfter`,
      contentType: 'markdown',
    });

    let blockPosition = -1;
    let blockSize = 0;
    editor.state.doc.descendants((node, position) => {
      if (node.type.name !== 'staticCustomBlock') return;
      blockPosition = position;
      blockSize = node.nodeSize;
    });
    expect(blockPosition).toBeGreaterThanOrEqual(0);
    expect(editor.getMarkdown()).toContain(raw);

    editor.view.dispatch(
      editor.state.tr.delete(blockPosition, blockPosition + blockSize),
    );
    expect(editor.getMarkdown()).toContain(raw);
    editor.destroy();
  });
});
