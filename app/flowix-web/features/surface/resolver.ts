import type { PluginArtifactRendererId } from '@features/plugin/plugin-note';
import { canonicalPath } from '@/lib/path';
import type {
  DocumentSurfaceContext,
  PluginWorkbenchContext,
  ResolveWorkColumnSurfaceInput,
  WorkColumnSurface,
} from './types';
import type { WorkColumnTarget } from '@features/workspace/store/work-column-target';

function assertNever(value: never): never {
  throw new Error(`Unsupported plugin artifact renderer: ${String(value)}`);
}

function emptySurface(message: string): WorkColumnSurface {
  return { kind: 'empty', instanceKey: 'empty', message };
}

function artifactSurface(
  instanceKey: string,
  memoId: string,
  transitionId: number | undefined,
  renderer: PluginArtifactRendererId | null,
): WorkColumnSurface {
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

function resolveDocumentSurface(document: DocumentSurfaceContext): WorkColumnSurface {
  return document.markdown;
}

function resolveArtifactTargetSurface(
  target: Extract<WorkColumnTarget, { kind: 'artifact' }>,
): WorkColumnSurface {
  const pointerMemoId = target.pointerMemoId.trim();
  if (!pointerMemoId) return emptySurface('');
  return artifactSurface(
    `artifact:${pointerMemoId}`,
    pointerMemoId,
    undefined,
    target.renderer,
  );
}

function samePath(left: string | null | undefined, right: string | null | undefined): boolean {
  return left != null && right != null && canonicalPath(left) === canonicalPath(right);
}

function sameTransition(left: number | null | undefined, right: number | null): boolean {
  return left === right;
}

/** Reject adjacent-render stale contexts instead of mounting them under a new target. */
function isMemoDocumentContext(
  target: Extract<WorkColumnTarget, { kind: 'memo' }>,
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
    && sameTransition(props.transitionId, target.transitionId);
}

function isExternalDocumentContext(
  target: Extract<WorkColumnTarget, { kind: 'external' }>,
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
    && sameTransition(props.transitionId, target.transitionId);
}

function isPluginWorkbenchContext(
  target: Extract<WorkColumnTarget, { kind: 'plugin-workbench' }>,
  context: PluginWorkbenchContext,
): boolean {
  return context.plugin.manifest.id === target.plugin.manifest.id;
}

function resolveWorkColumnTarget(
  target: WorkColumnTarget,
  input: Pick<ResolveWorkColumnSurfaceInput, 'document' | 'pluginWorkbench' | 'emptyMessage'>,
): WorkColumnSurface {
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
    case 'artifact':
      return resolveArtifactTargetSurface(target);
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

/** Resolve the main workspace target with presentation data supplied by the host. */
export function resolveWorkColumnSurface(input: ResolveWorkColumnSurfaceInput): WorkColumnSurface {
  return resolveWorkColumnTarget(input.navigation.target, input);
}
