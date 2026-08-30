import { describe, expect, it } from 'vitest';
import type { MemoItem } from '@/types/memo-item';
import type { PluginDescriptor } from '@platform/tauri/client';
import type { MarkdownSurface } from './types';
import type {
  WorkspaceNavigationState,
  WorkspaceTarget,
} from '@features/workspace/store/workspace-target';
import { resolveTabSurface, resolveWorkspaceSurface } from './resolver';

function memo(properties: Record<string, unknown>, id = 'memo-1'): MemoItem {
  return {
    id,
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

function markdownSurface(options: {
  filePath?: string;
  memoId?: string | null;
  transitionId?: number | null;
  notebookId?: string | null;
  notebookPath?: string | null;
  isExternalDocument?: boolean;
  externalScopePath?: string | null;
} = {}): MarkdownSurface {
  return {
    kind: 'markdown',
    instanceKey: options.memoId ? `memo:${options.memoId}` : `path:${options.filePath ?? '/notebook/note.md'}`,
    props: {
      filePath: options.filePath ?? '/notebook/note.md',
      memoId: options.memoId === undefined ? 'memo-1' : options.memoId,
      transitionId: options.transitionId ?? null,
      notebookId: options.notebookId ?? 'notebook-1',
      notebookPath: options.notebookPath ?? '/notebook',
      isExternalDocument: options.isExternalDocument,
      externalScopePath: options.externalScopePath,
    },
  };
}

function plugin(id = 'mindmap'): PluginDescriptor {
  return {
    manifest: {
      schemaVersion: 1,
      id,
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

const memoTarget = {
  kind: 'memo' as const,
  memoId: 'memo-1',
  path: '/notebook/note.md',
  notebookId: 'notebook-1',
  notebookPath: '/notebook',
  transitionId: 1,
};

function navigation(target: WorkspaceTarget | WorkspaceNavigationState) {
  return 'phase' in target
    ? target
    : {
        phase: 'committed' as const,
        requestId: 1,
        target,
        pendingTarget: null,
        previousTarget: null,
        failure: null,
        retryToken: null,
      };
}

function documentIdentity(
  options: { external?: boolean; path?: string; transitionId?: number | null } = {},
) {
  return options.external
    ? {
        kind: 'external' as const,
        path: options.path ?? '/notebook/note.md',
        scopePath: '/files',
        transitionId: options.transitionId ?? null,
      }
    : {
        kind: 'memo' as const,
        memoId: 'memo-1',
        path: options.path ?? '/notebook/note.md',
        notebookId: 'notebook-1',
        notebookPath: '/notebook',
        transitionId: options.transitionId ?? null,
      };
}

describe('surface resolvers', () => {
  it('resolves memo, external, plugin, agent, web, and empty workspace targets', () => {
    const markdown = markdownSurface({ transitionId: 1 });
    expect(resolveWorkspaceSurface({
      navigation: navigation(memoTarget),
      document: { identity: documentIdentity({ transitionId: 1 }), memo: memo({}), markdown },
      emptyMessage: 'empty',
    })).toBe(markdown);

    expect(resolveWorkspaceSurface({
      navigation: navigation({
        kind: 'external',
        path: '/files/readme.md',
        scopePath: '/files',
        transitionId: 2,
      }),
      document: {
        identity: documentIdentity({ external: true, path: '/files/readme.md', transitionId: 2 }),
        memo: null,
        markdown: markdownSurface({
          filePath: '/files/readme.md',
          memoId: null,
          transitionId: 2,
          isExternalDocument: true,
          externalScopePath: '/files',
        }),
      },
      emptyMessage: 'empty',
    }).kind).toBe('markdown');

    expect(resolveWorkspaceSurface({
      navigation: navigation({ kind: 'plugin-workbench', plugin: plugin('plugin-a') }),
      pluginWorkbench: {
        plugin: plugin('plugin-a'),
        notebookPath: '/notebook',
        currentNotePath: null,
        currentNoteContent: '',
      },
      emptyMessage: 'empty',
    }).kind).toBe('plugin-workbench');

    expect(resolveWorkspaceSurface({
      navigation: navigation({ kind: 'agent-conversation', instanceId: 'conversation-1' }),
      emptyMessage: 'empty',
    }).kind).toBe('agent-conversation');
    expect(resolveWorkspaceSurface({
      navigation: navigation({ kind: 'web', url: 'https://example.com' }),
      emptyMessage: 'empty',
    }).kind).toBe('web');
    expect(resolveWorkspaceSurface({ navigation: navigation({ kind: 'empty' }), emptyMessage: 'empty' })).toEqual({
      kind: 'empty',
      instanceKey: 'empty',
      message: 'empty',
    });
  });

  it('maps artifact renderer metadata to the product surface', () => {
    const surface = resolveWorkspaceSurface({
      navigation: navigation(memoTarget),
      document: {
        identity: documentIdentity({ transitionId: 1 }),
        memo: memo({
          flowix_note_type: 'mindmap',
          flowix_plugin: 'mindmap',
          flowix_artifact: { renderer: 'markmap' },
        }),
        markdown: markdownSurface({ transitionId: 1 }),
        artifact: { memoId: 'memo-1', transitionId: 1 },
      },
      emptyMessage: 'empty',
    });
    expect(surface).toMatchObject({ kind: 'mindmap', instanceKey: 'artifact:memo-1', renderer: 'markmap' });
  });

  it('rejects stale or cross-identity workspace contexts', () => {
    const stale = resolveWorkspaceSurface({
      navigation: navigation(memoTarget),
      document: { identity: documentIdentity({ transitionId: 1 }), memo: memo({}, 'other-memo'), markdown: markdownSurface({ transitionId: 1 }) },
      emptyMessage: 'empty',
    });
    expect(stale.kind).toBe('empty');

    const wrongPath = resolveWorkspaceSurface({
      navigation: navigation(memoTarget),
      document: {
        identity: documentIdentity({ path: '/notebook/old.md', transitionId: 1 }),
        memo: memo({}),
        markdown: markdownSurface({ filePath: '/notebook/old.md', transitionId: 1 }),
      },
      emptyMessage: 'empty',
    });
    expect(wrongPath.kind).toBe('empty');

    const wrongPlugin = resolveWorkspaceSurface({
      navigation: navigation({ kind: 'plugin-workbench', plugin: plugin('plugin-a') }),
      pluginWorkbench: {
        plugin: plugin('plugin-b'),
        notebookPath: undefined,
        currentNotePath: null,
        currentNoteContent: '',
      },
      emptyMessage: 'empty',
    });
    expect(wrongPlugin.kind).toBe('empty');
  });

  it('resolves an independent tab target and rejects malformed document context', () => {
    const document = {
      identity: documentIdentity({ transitionId: 1 }),
      memo: memo({
        flowix_note_type: 'mindmap',
        flowix_plugin: 'mindmap',
        flowix_artifact: { renderer: 'markmap' },
      }),
      markdown: markdownSurface({ transitionId: 1 }),
      artifact: { memoId: 'memo-1', transitionId: 1 },
    };
    const target = {
      kind: 'memo' as const,
      memoId: 'memo-1',
      path: '/notebook/note.md',
      notebookId: 'notebook-1',
      notebookPath: '/notebook',
    };
    expect(resolveTabSurface({ target: { kind: 'document', target, document } }).kind).toBe('mindmap');
    expect(resolveTabSurface({
      target: {
        kind: 'document',
        target,
        document: { ...document, artifact: { memoId: 'other-memo', transitionId: 1 } },
      },
    }).kind).toBe('empty');

    expect(resolveTabSurface({
      target: {
        kind: 'document',
        target: { ...target, path: '/notebook/other.md' },
        document,
      },
    }).kind).toBe('empty');
  });
});
