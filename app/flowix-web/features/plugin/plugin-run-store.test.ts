import { beforeEach, describe, expect, it } from 'vitest';
import { usePluginRunStore } from './plugin-run-store';

describe('plugin run store', () => {
  beforeEach(() => {
    usePluginRunStore.setState({ runs: {}, latestRunIdByContext: {} });
  });

  it('keeps the latest run isolated by plugin and notebook', () => {
    const ingest = usePluginRunStore.getState().ingestEvent;
    ingest({ runId: 'run-a', pluginId: 'mindmap', status: 'started', agentType: 'codex' });
    ingest({ runId: 'run-b', pluginId: 'mindmap', status: 'started', agentType: 'codex' });
    ingest({ runId: 'run-a', pluginId: 'mindmap', status: 'completed', agentType: 'codex' });
    usePluginRunStore.getState().registerRunContext('run-a', 'mindmap', { notebookPath: '/notes/a' });
    usePluginRunStore.getState().registerRunContext('run-b', 'mindmap', { notebookPath: '/notes/b' });

    const state = usePluginRunStore.getState();
    expect(Object.keys(state.runs)).toEqual(['run-a', 'run-b']);
    expect(state.getLatestForPlugin('mindmap', '/notes/a')?.runId).toBe('run-a');
    expect(state.getLatestForPlugin('mindmap', '/notes/b')?.runId).toBe('run-b');
    expect(state.getLatestForPlugin('mindmap', '/notes/b')?.status).toBe('running');
  });

  it('retains a completed artifact after the originating surface is gone', () => {
    const ingest = usePluginRunStore.getState().ingestEvent;
    ingest({ runId: 'run-a', pluginId: 'mindmap', status: 'started', agentType: 'codex' });
    ingest({
      runId: 'run-a',
      pluginId: 'mindmap',
      status: 'completed',
      agentType: 'codex',
      artifact: {
        pluginId: 'mindmap',
        path: '/notes/.flowix/plugin/mindmap/output.md',
        name: 'Roadmap',
        createdAt: '2026-09-05T00:00:00Z',
        format: 'markdown',
        renderer: 'markmap',
        content: '# Roadmap',
        noteId: 'memo-1',
      },
    });
    usePluginRunStore.getState().registerRunContext('run-a', 'mindmap', { notebookPath: '/notes' });

    const run = usePluginRunStore.getState().getLatestForPlugin('mindmap', '/notes');
    expect(run?.status).toBe('completed');
    expect(run?.artifact?.content).toBe('# Roadmap');
  });
});
