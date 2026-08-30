import { getPluginNoteInfo, type PluginArtifactRendererId } from '@features/plugin/plugin-note';
import { canonicalPath } from '@/lib/path';
import type {
  DocumentSurfaceContext,
  PluginWorkbenchContext,
  ResolveTabSurfaceInput,
  ResolveWorkspaceSurfaceInput,
  TabDocumentTarget,
  TabSurfaceTarget,
  ThirdColumnSurface,
} from './types';
import type { WorkspaceTarget } from '@features/workspace/store/workspace-target';

function assertNever(value: never): never {
  throw new Error(`Unsupported plugin artifact renderer: ${String(value)}`);
}

function emptySurface(message: string): ThirdColumnSurface {
  return { kind: 'empty', instanceKey: 'empty', message };
}

function artifactSurface(
  instanceKey: string,
  memoId: string,
  transitionId: number | undefined,
  renderer: PluginArtifactRendererId | null,
): ThirdColumnSurface {
  const base = { instanceKey, renderer, props: { memoId, transitionId } };
  switch (renderer) {
    case 'markmap': return { ...base, kind: 'mindmap', renderer };
    case 'html':
    case 'webpage': return { ...base, kind: 'html', renderer };
    case 'json-viewer': return { ...base, kind: 'json', renderer };
    case 'markdown':
    case 'text': return { ...base, kind: 'text', renderer };
    case null: return { ...base, kind: 'plugin-artifact' };
    default: return assertNever(renderer);
  }
}

function resolveDocumentSurface(document: DocumentSurfaceContext): ThirdColumnSurface {
  if (document.artifact) {
    const noteInfo = getPluginNoteInfo(document.memo);
    if (noteInfo) {
      const renderer = noteInfo.renderer
        ?? (noteInfo.noteType === 'mindmap' ? 'markmap' : null);
      return artifactSurface(
        `artifact:${document.artifact.memoId}`,
        document.artifact.memoId,
        document.artifact.transitionId,
        renderer,
      );
    }
  }
  return document.markdown;
}

function samePath(left: string | null | undefined, right: string | null | undefined): boolean {
  return left != null && right != null && canonicalPath(left) === canonicalPath(right);
}

function sameTransition(left: number | null | undefined, right: number | null): boolean {
  return left === right;
}

/** Reject adjacent-render stale contexts instead of mounting them under a new target. */
function isMemoDocumentContext(
  target: Extract<WorkspaceTarget, { kind: 'memo' }>,
  document: DocumentSurfaceContext,
): boolean {
  const props = document.markdown.props;
  return document.identity.kind === 'memo'
    && document.identity.memoId === target.memoId
    && samePath(document.identity.path, target.path)
    && document.identity.notebookId === target.notebookId
    && ((document.identity.notebookPath == null && target.notebookPath == null)
      || samePath(document.identity.notebookPath, target.notebookPath))
    && sameTransition(document.identity.transitionId, target.transitionId)
    && document.memo?.id === target.memoId
    && props.memoId === target.memoId
    && props.notebookId === target.notebookId
    && ((props.notebookPath == null && target.notebookPath == null)
      || samePath(props.notebookPath, target.notebookPath))
    && !props.isExternalDocument
    && samePath(props.filePath, target.path)
    && sameTransition(props.transitionId, target.transitionId)
    && (!document.artifact || (
      document.artifact.memoId === target.memoId
      && sameTransition(document.artifact.transitionId, target.transitionId)
    ));
}

function isExternalDocumentContext(
  target: Extract<WorkspaceTarget, { kind: 'external' }>,
  document: DocumentSurfaceContext,
): boolean {
  const props = document.markdown.props;
  return document.identity.kind === 'external'
    && samePath(document.identity.path, target.path)
    && ((document.identity.scopePath == null && target.scopePath == null)
      || samePath(document.identity.scopePath, target.scopePath))
    && sameTransition(document.identity.transitionId, target.transitionId)
    && document.memo === null
    && props.memoId === null
    && props.isExternalDocument === true
    && samePath(props.filePath, target.path)
    && ((props.externalScopePath == null && target.scopePath == null)
      || samePath(props.externalScopePath, target.scopePath))
    && sameTransition(props.transitionId, target.transitionId)
    && !document.artifact;
}

function isPluginWorkbenchContext(
  target: Extract<WorkspaceTarget, { kind: 'plugin-workbench' }>,
  context: PluginWorkbenchContext,
): boolean {
  return context.plugin.manifest.id === target.plugin.manifest.id;
}

function resolveWorkspaceTarget(
  target: WorkspaceTarget,
  input: Pick<ResolveWorkspaceSurfaceInput, 'document' | 'pluginWorkbench' | 'emptyMessage'>,
): ThirdColumnSurface {
  switch (target.kind) {
    case 'empty':
      return emptySurface(input.emptyMessage);
    case 'web':
      return { kind: 'web', instanceKey: target.url, url: target.url };
    case 'agent-conversation':
      return target.instanceId.trim()
        ? { kind: 'agent-conversation', instanceKey: `agent:${target.instanceId}`, instanceId: target.instanceId }
        : emptySurface(input.emptyMessage);
    case 'plugin-workbench': {
      const context = input.pluginWorkbench;
      if (!context || !isPluginWorkbenchContext(target, context)) return emptySurface(input.emptyMessage);
      return {
        kind: 'plugin-workbench',
        instanceKey: `plugin:${target.plugin.manifest.id}`,
        props: context,
      };
    }
    case 'memo':
      return input.document && isMemoDocumentContext(target, input.document)
        ? resolveDocumentSurface(input.document)
        : emptySurface(input.emptyMessage);
    case 'external':
      return input.document && isExternalDocumentContext(target, input.document)
        ? resolveDocumentSurface(input.document)
        : emptySurface(input.emptyMessage);
    default:
      return assertNever(target);
  }
}

function isTabDocumentContext(
  target: TabDocumentTarget,
  document: DocumentSurfaceContext,
): boolean {
  const props = document.markdown.props;
  if (target.kind === 'memo') {
    if (
      document.identity.kind !== 'memo'
      || document.identity.memoId !== target.memoId
      || !samePath(document.identity.path, target.path)
      || document.identity.notebookId !== target.notebookId
      || !samePath(document.identity.notebookPath, target.notebookPath)
      || document.memo?.id !== target.memoId
      || props.memoId !== target.memoId
      || !samePath(props.filePath, target.path)
      || props.notebookId !== target.notebookId
      || !samePath(props.notebookPath, target.notebookPath)
      || (document.identity.transitionId !== null
        && props.transitionId !== null
        && document.identity.transitionId !== props.transitionId)
      || props.isExternalDocument
    ) return false;
  } else if (
    document.identity.kind !== 'external'
    || !samePath(document.identity.path, target.path)
    || ((document.identity.scopePath == null && target.scopePath == null)
      || samePath(document.identity.scopePath, target.scopePath)) === false
    || document.memo !== null
    || props.memoId !== null
    || ((props.externalScopePath == null && target.scopePath == null)
      || samePath(props.externalScopePath, target.scopePath)) === false
    || (document.identity.transitionId !== null
      && props.transitionId !== null
      && document.identity.transitionId !== props.transitionId)
    || props.isExternalDocument !== true
  ) return false;
  if (document.artifact && document.artifact.memoId !== props.memoId) return false;
  if (
    document.artifact
    && document.artifact.transitionId !== undefined
    && props.transitionId !== null
    && document.artifact.transitionId !== props.transitionId
  ) return false;
  if (props.isExternalDocument) {
    return document.memo === null && props.memoId === null && !document.artifact;
  }
  return props.memoId === null
    ? document.memo === null
    : document.memo?.id === props.memoId;
}

function resolveTabTarget(target: TabSurfaceTarget): ThirdColumnSurface {
  switch (target.kind) {
    case 'web':
      return target.url.trim()
        ? { kind: 'web', instanceKey: target.url, url: target.url }
        : emptySurface('');
    case 'document':
      return isTabDocumentContext(target.target, target.document)
        ? resolveDocumentSurface(target.document)
        : emptySurface('');
    case 'plugin-workbench':
      return {
        kind: 'plugin-workbench',
        instanceKey: `plugin:${target.pluginWorkbench.plugin.manifest.id}`,
        props: target.pluginWorkbench,
      };
    case 'agent-conversation':
      return target.instanceId.trim()
        ? { kind: 'agent-conversation', instanceKey: `agent:${target.instanceId}`, instanceId: target.instanceId }
        : emptySurface('');
    case 'empty':
      return emptySurface(target.message);
    default:
      return assertNever(target);
  }
}

/** Resolve the main workspace target with presentation data supplied by the host. */
export function resolveWorkspaceSurface(input: ResolveWorkspaceSurfaceInput): ThirdColumnSurface {
  return resolveWorkspaceTarget(input.navigation.target, input);
}

/** Resolve an independent tab-window target. */
export function resolveTabSurface(input: ResolveTabSurfaceInput): ThirdColumnSurface {
  return resolveTabTarget(input.target);
}
