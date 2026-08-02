import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';

import { Tag } from './tag';

describe('tag decorations', () => {
  it('renders hyphenated and underscored tag paths as complete tags', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Tag],
      content: '<p>#Long-Term-Task #project_one/phase-2</p>',
    });

    expect([...host.querySelectorAll('.tag-node')].map((node) => node.textContent)).toEqual([
      '#Long-Term-Task',
      '#project_one/phase-2',
    ]);

    editor.destroy();
    host.remove();
  });

  it('does not render punctuation-only segments as tags', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, Tag],
      content: '<p>#--- #project/___</p>',
    });

    expect(host.querySelectorAll('.tag-node')).toHaveLength(0);

    editor.destroy();
    host.remove();
  });
});
