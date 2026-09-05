import { describe, expect, it } from 'vitest';
import { canonicalUrl, contentIdentityKey } from './workspace-content-identity';

describe('workspace content identity', () => {
  it('normalizes web URLs without collapsing the scheme separator', () => {
    expect(canonicalUrl('  HTTPS://Example.com/docs  ')).toBe('https://example.com/docs');
    expect(contentIdentityKey({ kind: 'web', url: 'https://example.com/docs' })).toBe(
      'web:https://example.com/docs',
    );
  });

  it('keeps different content models in separate identity namespaces', () => {
    expect(contentIdentityKey({ kind: 'memo', memoId: 'same-id' })).toBe('memo:same-id');
    expect(contentIdentityKey({ kind: 'external', path: '/notes/same-id' })).toBe(
      'external:/notes/same-id',
    );
    expect(contentIdentityKey({ kind: 'artifact', pointerMemoId: 'same-id' })).toBe(
      'artifact:same-id',
    );
  });
});
