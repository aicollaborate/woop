import { describe, expect, it } from 'vitest';
import type { MemoItem } from '@/types/memo-item';
import { getPluginNoteInfo } from './plugin-note';

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

describe('getPluginNoteInfo', () => {
  it('reads a supported artifact renderer from pointer metadata', () => {
    expect(getPluginNoteInfo(memo({
      flowix_note_type: 'report',
      flowix_plugin: 'report-plugin',
      flowix_artifact: { renderer: 'html' },
    }))).toEqual({
      noteType: 'report',
      pluginId: 'report-plugin',
      renderer: 'html',
    });
  });

  it('keeps valid plugin pointers with missing or unknown renderers resolvable', () => {
    expect(getPluginNoteInfo(memo({
      flowix_note_type: 'legacy',
      flowix_plugin: 'legacy-plugin',
      flowix_artifact: { renderer: 'future-renderer' },
    }))).toEqual({
      noteType: 'legacy',
      pluginId: 'legacy-plugin',
      renderer: null,
    });
  });

  it('rejects ordinary notes and incomplete pointer metadata', () => {
    expect(getPluginNoteInfo(memo({}))).toBeNull();
    expect(getPluginNoteInfo(memo({ flowix_note_type: 'mindmap' }))).toBeNull();
  });
});
