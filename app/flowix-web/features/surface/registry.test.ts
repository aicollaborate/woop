import { describe, expect, it } from 'vitest';
import {
  getThirdColumnSurfaceDefinition,
  surfaceSupports,
  thirdColumnSurfaceRegistry,
} from './registry';
import type { ThirdColumnSurface, ThirdColumnSurfaceKind } from './types';

function surface(kind: ThirdColumnSurfaceKind): ThirdColumnSurface {
  switch (kind) {
    case 'markdown':
      return { kind, instanceKey: 'markdown:1', props: { filePath: '/note.md' } };
    case 'mindmap':
      return {
        kind,
        instanceKey: 'artifact:1',
        renderer: 'markmap',
        props: { memoId: 'memo-1' },
      };
    case 'html':
      return {
        kind,
        instanceKey: 'artifact:1',
        renderer: 'html',
        props: { memoId: 'memo-1' },
      };
    case 'json':
      return {
        kind,
        instanceKey: 'artifact:1',
        renderer: 'json-viewer',
        props: { memoId: 'memo-1' },
      };
    case 'text':
      return {
        kind,
        instanceKey: 'artifact:1',
        renderer: 'text',
        props: { memoId: 'memo-1' },
      };
    case 'plugin-artifact':
      return {
        kind,
        instanceKey: 'artifact:1',
        renderer: null,
        props: { memoId: 'memo-1' },
      };
    case 'agent-conversation':
      return { kind, instanceKey: 'agent:1', instanceId: 'agent-1' };
    case 'plugin-workbench':
      throw new Error('Plugin workbench is not needed by these capability tests');
    case 'web':
      return { kind, instanceKey: 'web:1', url: 'https://example.com' };
    case 'empty':
      return { kind, instanceKey: 'empty', message: 'Empty' };
  }
}

describe('thirdColumnSurfaceRegistry', () => {
  it('registers every supported product-level surface kind', () => {
    expect(Object.keys(thirdColumnSurfaceRegistry).sort()).toEqual([
      'agent-conversation',
      'empty',
      'html',
      'json',
      'markdown',
      'mindmap',
      'plugin-artifact',
      'plugin-workbench',
      'text',
      'web',
    ]);
  });

  it('keeps Markdown content actions on the editable Markdown surface', () => {
    const markdown = surface('markdown');

    expect(getThirdColumnSurfaceDefinition(markdown).chrome).toBe('document');
    expect(surfaceSupports(markdown, 'edit')).toBe(true);
    expect(surfaceSupports(markdown, 'search')).toBe(true);
    expect(surfaceSupports(markdown, 'copy-content')).toBe(true);
    expect(surfaceSupports(markdown, 'export-content')).toBe(true);
    expect(surfaceSupports(markdown, 'fit')).toBe(false);
  });

  it('exposes canvas controls without leaking pointer-note editing actions', () => {
    const mindmap = surface('mindmap');

    expect(getThirdColumnSurfaceDefinition(mindmap).chrome).toBe('document');
    expect(surfaceSupports(mindmap, 'fit')).toBe(true);
    expect(surfaceSupports(mindmap, 'zoom')).toBe(true);
    expect(surfaceSupports(mindmap, 'fullscreen')).toBe(true);
    expect(surfaceSupports(mindmap, 'edit')).toBe(false);
    expect(surfaceSupports(mindmap, 'export-content')).toBe(false);
    expect(surfaceSupports(surface('html'), 'fullscreen')).toBe(true);
  });

  it('uses agent chrome and conversation-specific capabilities for agents', () => {
    const agent = surface('agent-conversation');

    expect(getThirdColumnSurfaceDefinition(agent).chrome).toBe('agent');
    expect(surfaceSupports(agent, 'stream-conversation')).toBe(true);
    expect(surfaceSupports(agent, 'edit')).toBe(false);
  });
});
