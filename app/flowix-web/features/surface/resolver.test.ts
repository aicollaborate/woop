import { describe, expect, it } from 'vitest';
import type { MemoItem } from '@/types/memo-item';
import type { PluginDescriptor } from '@platform/tauri/client';
import type { MarkdownSurface } from './types';
import { resolveThirdColumnSurface } from './resolver';

function memo(properties: Record<string, unknown>): MemoItem {
  return {
    id: 'memo-1',
    filename: 'note.md',
    preview: '',
    tags: [],
    todos: [],
    agents: [],
    createdAt: 0,
    updatedAt: 0,
    favorited: false,
    icon: null,
    colors: [],
    properties,
  };
}

function markdownSurface(): MarkdownSurface {
  return {
    kind: 'markdown',
    instanceKey: 'memo:memo-1',
    props: {
      filePath: '/notebook/note.md',
      memoId: 'memo-1',
    },
  };
}

function plugin(): PluginDescriptor {
  return {
    manifest: {
      schemaVersion: 1,
      id: 'mindmap',
      name: 'Mindmap',
      version: '1.0.0',
      kind: 'agent-markdown',
      ui: { placement: 'sidebar', order: 1, icon: 'mindmap' },
      input: { fields: [] },
      agent: { skill: 'SKILL.md' },
      output: {
        format: 'markdown',
        directory: '.plugin-output/mindmap',
        extension: '.md',
        renderer: 'markmap',
      },
    },
    installedPath: '/plugins/mindmap',
    skill: '',
    isSystem: true,
  };
}

describe('resolveThirdColumnSurface', () => {
  it('keeps ordinary memo and external files on the Markdown surface', () => {
    const markdown = markdownSurface();
    const surface = resolveThirdColumnSurface({
      document: { memo: memo({}), markdown },
      emptyMessage: 'empty',
    });

    expect(surface).toBe(markdown);
  });

  it('resolves a mindmap pointer to a product-level mindmap surface', () => {
    const surface = resolveThirdColumnSurface({
      document: {
        memo: memo({
          flowix_note_type: 'mindmap',
          flowix_plugin: 'mindmap',
          flowix_artifact: { renderer: 'markmap' },
        }),
        markdown: markdownSurface(),
        artifact: { memoId: 'memo-1', transitionId: 7 },
      },
      emptyMessage: 'empty',
    });

    expect(surface).toMatchObject({
      kind: 'mindmap',
      instanceKey: 'artifact:memo-1',
      renderer: 'markmap',
      props: { memoId: 'memo-1', transitionId: 7 },
    });
  });

  it('maps built-in artifact renderers to parallel surface kinds', () => {
    const cases = [
      ['html', 'html'],
      ['json-viewer', 'json'],
      ['markdown', 'text'],
      ['text', 'text'],
    ] as const;

    for (const [renderer, expectedKind] of cases) {
      const surface = resolveThirdColumnSurface({
        document: {
          memo: memo({
            flowix_note_type: `fixture-${renderer}`,
            flowix_plugin: 'fixture',
            flowix_artifact: { renderer },
          }),
          markdown: markdownSurface(),
          artifact: { memoId: 'memo-1' },
        },
        emptyMessage: 'empty',
      });
      expect(surface.kind).toBe(expectedKind);
    }
  });

  it('preserves legacy mindmap pointers that do not store a renderer', () => {
    const surface = resolveThirdColumnSurface({
      document: {
        memo: memo({
          flowix_note_type: 'mindmap',
          flowix_plugin: 'mindmap',
        }),
        markdown: markdownSurface(),
        artifact: { memoId: 'memo-1' },
      },
      emptyMessage: 'empty',
    });

    expect(surface.kind).toBe('mindmap');
  });

  it('prioritizes an opened artifact over workbench and conversation state', () => {
    const surface = resolveThirdColumnSurface({
      document: {
        memo: memo({
          flowix_note_type: 'mindmap',
          flowix_plugin: 'mindmap',
        }),
        markdown: markdownSurface(),
        artifact: { memoId: 'memo-1' },
      },
      pluginWorkbench: {
        plugin: plugin(),
        notebookPath: '/notebook',
        currentNotePath: null,
        currentNoteContent: '',
      },
      agentConversationId: 'conversation-1',
      emptyMessage: 'empty',
    });

    expect(surface.kind).toBe('mindmap');
  });

  it('resolves workbench, conversation, web, and empty states explicitly', () => {
    expect(resolveThirdColumnSurface({
      pluginWorkbench: {
        plugin: plugin(),
        notebookPath: '/notebook',
        currentNotePath: null,
        currentNoteContent: '',
      },
      emptyMessage: 'empty',
    }).kind).toBe('plugin-workbench');

    expect(resolveThirdColumnSurface({
      agentConversationId: 'conversation-1',
      emptyMessage: 'empty',
    }).kind).toBe('agent-conversation');

    expect(resolveThirdColumnSurface({
      webUrl: 'https://example.com',
      emptyMessage: 'empty',
    }).kind).toBe('web');

    expect(resolveThirdColumnSurface({ emptyMessage: 'empty' })).toEqual({
      kind: 'empty',
      instanceKey: 'empty',
      message: 'empty',
    });
  });
});
