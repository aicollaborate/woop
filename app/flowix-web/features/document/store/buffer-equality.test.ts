import { describe, expect, it } from 'vitest';

import { isContentSemanticallyEqual, isDocumentContentEqual } from './buffer-equality';

describe('document buffer semantic equality', () => {
  it('ignores line endings and YAML key order', () => {
    const left = '---\r\nkey: abc12345\r\nstatus: draft\r\n---\r\nbody\r\n';
    const right = '---\nstatus: draft\nkey: abc12345\n---\nbody\n';
    expect(isContentSemanticallyEqual(left, right)).toBe(true);
  });

  it('treats a tags change as a real edit', () => {
    const left = '---\nkey: abc12345\ntags: [product]\n---\nbody\n';
    const right = '---\nkey: abc12345\ntags: [design]\n---\nbody\n';
    expect(isContentSemanticallyEqual(left, right)).toBe(false);
  });

  it('does not discard changes in invalid YAML', () => {
    const left = '---\ntags: [product\n---\nbody\n';
    const right = '---\ntags: [design\n---\nbody\n';
    expect(isContentSemanticallyEqual(left, right)).toBe(false);
  });

  it('keeps code and plain-text whitespace byte-sensitive', () => {
    const identity = { kind: 'external' as const, path: '/project/src/main.ts' };
    expect(isDocumentContentEqual(identity, 'const value = 1;\n', 'const value = 1;')).toBe(false);
    expect(isDocumentContentEqual(identity, '\nconst value = 1;', 'const value = 1;')).toBe(false);
  });

  it('retains semantic comparison for external Markdown', () => {
    const identity = { kind: 'external' as const, path: '/notes/readme.md' };
    expect(isDocumentContentEqual(identity, 'body\n', 'body')).toBe(true);
  });
});
