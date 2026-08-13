import type { MemoItem } from '@/types/memo-item';

export interface PluginNoteInfo {
  pluginId: string;
  noteType: string;
}

export function getPluginNoteInfo(memo: MemoItem | null | undefined): PluginNoteInfo | null {
  if (!memo) return null;
  const noteType = memo.properties?.flowix_note_type;
  const pluginId = memo.properties?.flowix_plugin;
  if (typeof noteType !== 'string' || typeof pluginId !== 'string') return null;
  if (!noteType.trim() || !pluginId.trim()) return null;
  return { noteType, pluginId };
}
