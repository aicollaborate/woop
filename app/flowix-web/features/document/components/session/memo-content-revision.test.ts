import { beforeEach, describe, expect, it } from 'vitest';

import {
  markMemoCommitApplied,
  newerPendingMemoCommit,
  resetMemoContentRevisionsForTests,
  shouldApplyMemoCommit,
} from '@features/document/store/memo-content-revision';

describe('memo content revision reconciliation', () => {
  beforeEach(resetMemoContentRevisionsForTests);

  it('ignores the same change id and older revisions after a commit is applied', () => {
    markMemoCommitApplied('memo-1', { revision: 3, changeId: 'change-3' });

    expect(shouldApplyMemoCommit('memo-1', { revision: 3, changeId: 'change-3' })).toBe(false);
    expect(shouldApplyMemoCommit('memo-1', { revision: 2, changeId: 'change-2' })).toBe(false);
    expect(shouldApplyMemoCommit('memo-1', { revision: 4, changeId: 'change-4' })).toBe(true);
  });

  it('keeps the newest revision while a dirty document defers reload', () => {
    const revision4 = { id: 'memo-1', path: '/notes/one.md', revision: 4, changeId: 'change-4' };
    const revision5 = { id: 'memo-1', path: '/notes/one.md', revision: 5, changeId: 'change-5' };

    expect(newerPendingMemoCommit(revision5, revision4)).toBe(revision5);
    expect(newerPendingMemoCommit(revision4, revision5)).toBe(revision5);
  });

  it('accepts legacy events during a rolling backend upgrade', () => {
    markMemoCommitApplied('memo-1', { revision: 3, changeId: 'change-3' });
    expect(shouldApplyMemoCommit('memo-1', {})).toBe(true);
  });
});
