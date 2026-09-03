import { canonicalPath } from '@/lib/path';

export type WorkspaceContentIdentity =
  | { kind: 'memo'; memoId: string }
  | { kind: 'external'; path: string }
  | { kind: 'agent-conversation'; instanceId: string };

export function workspaceContentIdentityKey(
  identity: WorkspaceContentIdentity,
): string | null {
  switch (identity.kind) {
    case 'memo': {
      const memoId = identity.memoId.trim();
      return memoId ? `memo:${memoId}` : null;
    }
    case 'external': {
      const path = identity.path.trim();
      return path ? `external:${canonicalPath(path)}` : null;
    }
    case 'agent-conversation': {
      const instanceId = identity.instanceId.trim();
      return instanceId ? `agent:${instanceId}` : null;
    }
  }
}
