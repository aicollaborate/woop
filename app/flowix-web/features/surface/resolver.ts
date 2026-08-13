import { getPluginNoteInfo, type PluginArtifactRendererId } from '@features/plugin/plugin-note';
import type {
  ResolveThirdColumnSurfaceInput,
  ThirdColumnSurface,
} from './types';

function assertNever(value: never): never {
  throw new Error(`Unsupported plugin artifact renderer: ${String(value)}`);
}

function artifactSurface(
  instanceKey: string,
  memoId: string,
  transitionId: number | undefined,
  renderer: PluginArtifactRendererId | null,
): ThirdColumnSurface {
  const base = {
    instanceKey,
    renderer,
    props: { memoId, transitionId },
  };
  switch (renderer) {
    case 'markmap':
      return { ...base, kind: 'mindmap', renderer };
    case 'html':
      return { ...base, kind: 'html', renderer };
    case 'json-viewer':
      return { ...base, kind: 'json', renderer };
    case 'markdown':
    case 'text':
      return { ...base, kind: 'text', renderer };
    case null:
      return { ...base, kind: 'plugin-artifact' };
    default:
      return assertNever(renderer);
  }
}

/**
 * Resolve product navigation state into exactly one third-column surface.
 * Priority preserves the interaction contract: an opened artifact owns the
 * column before its workbench, followed by an active conversation, an
 * ordinary document, and finally the empty state.
 */
export function resolveThirdColumnSurface(
  input: ResolveThirdColumnSurfaceInput,
): ThirdColumnSurface {
  if (input.webUrl) {
    return { kind: 'web', instanceKey: input.webUrl, url: input.webUrl };
  }

  if (input.document?.artifact) {
    const noteInfo = getPluginNoteInfo(input.document.memo);
    if (noteInfo) {
      const renderer = noteInfo.renderer
        ?? (noteInfo.noteType === 'mindmap' ? 'markmap' : null);
      return artifactSurface(
        `artifact:${input.document.artifact.memoId}`,
        input.document.artifact.memoId,
        input.document.artifact.transitionId,
        renderer,
      );
    }
  }

  if (input.pluginWorkbench) {
    return {
      kind: 'plugin-workbench',
      instanceKey: `plugin:${input.pluginWorkbench.plugin.manifest.id}`,
      props: input.pluginWorkbench,
    };
  }

  if (input.agentConversationId) {
    return {
      kind: 'agent-conversation',
      instanceKey: `agent:${input.agentConversationId}`,
      instanceId: input.agentConversationId,
    };
  }

  if (input.document) return input.document.markdown;

  return { kind: 'empty', instanceKey: 'empty', message: input.emptyMessage };
}
