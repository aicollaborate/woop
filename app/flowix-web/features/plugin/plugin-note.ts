import type { MemoItem } from '@/types/memo-item';

export interface PluginNoteInfo {
  pluginId: string;
  noteType: string;
  renderer: PluginArtifactRendererId | null;
}

export type PluginArtifactRendererId =
  | 'markmap'
  | 'html'
  | 'webpage'
  | 'json-viewer'
  | 'markdown'
  | 'text';

const PLUGIN_ARTIFACT_RENDERERS = new Set<PluginArtifactRendererId>([
  'markmap',
  'html',
  'webpage',
  'json-viewer',
  'markdown',
  'text',
]);

function readArtifactRenderer(value: unknown): PluginArtifactRendererId | null {
  if (!value || typeof value !== 'object') return null;
  const renderer = (value as Record<string, unknown>).renderer;
  if (typeof renderer !== 'string') return null;
  return PLUGIN_ARTIFACT_RENDERERS.has(renderer as PluginArtifactRendererId)
    ? renderer as PluginArtifactRendererId
    : null;
}

export function getPluginNoteInfo(memo: MemoItem | null | undefined): PluginNoteInfo | null {
  if (!memo) return null;
  const noteType = memo.properties?.flowix_note_type;
  const pluginId = memo.properties?.flowix_plugin;
  if (typeof noteType !== 'string' || typeof pluginId !== 'string') return null;
  if (!noteType.trim() || !pluginId.trim()) return null;
  return {
    noteType,
    pluginId,
    renderer: readArtifactRenderer(memo.properties?.flowix_artifact),
  };
}
