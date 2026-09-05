import { canonicalPath } from '@/lib/path';

/**
 * Stable identity for content that can be opened by either workspace host.
 *
 * Paths and URLs deliberately have different normalizers. `canonicalPath`
 * collapses repeated slashes, which is correct for filesystem paths but would
 * corrupt the `//` in an URL scheme.
 */
export type ContentIdentity =
  | { kind: 'memo'; memoId: string }
  | { kind: 'artifact'; pointerMemoId: string }
  | { kind: 'external'; path: string }
  | { kind: 'file-browser'; folderPath: string }
  | { kind: 'web'; url: string }
  | { kind: 'agent-conversation'; instanceId: string };

export function canonicalUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export function contentIdentityKey(
  identity: ContentIdentity,
): string | null {
  switch (identity.kind) {
    case 'memo': {
      const memoId = identity.memoId.trim();
      return memoId ? `memo:${memoId}` : null;
    }
    case 'artifact': {
      const pointerMemoId = identity.pointerMemoId.trim();
      return pointerMemoId ? `artifact:${pointerMemoId}` : null;
    }
    case 'external': {
      const path = identity.path.trim();
      return path ? `external:${canonicalPath(path)}` : null;
    }
    case 'file-browser': {
      const folderPath = identity.folderPath.trim();
      return folderPath ? `file-browser:${canonicalPath(folderPath)}` : null;
    }
    case 'web': {
      const url = canonicalUrl(identity.url);
      return url ? `web:${url}` : null;
    }
    case 'agent-conversation': {
      const instanceId = identity.instanceId.trim();
      return instanceId ? `agent:${instanceId}` : null;
    }
  }
}

/** @deprecated Use ContentIdentity. */
export type WorkspaceContentIdentity = ContentIdentity;
/** @deprecated Use contentIdentityKey. */
export const workspaceContentIdentityKey = contentIdentityKey;
