import { describe, expect, it } from 'vitest';
import { resolveAuthorizedDefaultFiles } from '@/lib/agent-access-defaults';
import type { AgentAccessConfig, AgentAccessEntry } from '@/lib/types/agent-access';

function folder(path: string, overrides: Partial<AgentAccessEntry> = {}): AgentAccessEntry {
  return {
    id: `folder-${path}`,
    kind: 'folder',
    path,
    name: path,
    enabled: true,
    workspace: false,
    addedAt: 1,
    updatedAt: 1,
    missing: false,
    ...overrides,
  };
}

describe('resolveAuthorizedDefaultFiles', () => {
  it('filters missing, disabled, and unregistered default folders', () => {
    const config: AgentAccessConfig = {
      version: 1,
      entries: [
        folder('/资料/active'),
        folder('/资料/missing', { missing: true }),
        folder('/资料/disabled', { enabled: false }),
      ],
      defaults: {
        files: {
          notebook: {
            workspace: '/资料/missing',
            folders: ['/资料/active', '/资料/missing', '/资料/disabled', '/资料/stale'],
            notebooks: [],
          },
        },
      },
    };

    expect(resolveAuthorizedDefaultFiles(config, 'notebook')).toEqual({
      workspace: undefined,
      folders: ['/资料/active'],
      notebooks: [],
    });
  });
});
