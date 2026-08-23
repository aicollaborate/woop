import { describe, expect, it } from 'vitest';
import {
  getAgentConversationPresentation,
  getAgentConversationRuntimeCwd,
} from './conversation-presentation';

describe('agent conversation presentation', () => {
  it('prefers the frozen workspace cwd over the legacy cwd', () => {
    expect(getAgentConversationRuntimeCwd({
      runtimeConfig: {
        cwd: '/legacy',
        workspaceSnapshot: { cwd: '  /frozen  ' },
      } as never,
    })).toBe('/frozen');
  });

  it('returns no cwd for missing or blank runtime values', () => {
    expect(getAgentConversationRuntimeCwd(undefined)).toBeUndefined();
    expect(getAgentConversationRuntimeCwd({
      runtimeConfig: { cwd: '   ' } as never,
    })).toBeUndefined();
  });

  it('normalizes shared title and source presentation', () => {
    const presentation = getAgentConversationPresentation({
      title: '  ',
      source: {
        kind: 'thread-card',
        memoId: 'memo-1',
        documentPath: null,
      },
      runtimeConfig: null,
    }, 'Untitled');

    expect(presentation).toMatchObject({
      title: 'Untitled',
      hasSourceDocument: true,
      runtimeCwd: undefined,
    });
  });
});
