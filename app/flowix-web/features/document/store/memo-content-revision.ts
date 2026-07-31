import type { MemoContentCommit } from '@/types/memo';

interface AppliedMemoCommit {
  revision: number;
  changeId: string | null;
}

const appliedCommits = new Map<string, AppliedMemoCommit>();

/**
 * Legacy events without commit metadata remain consumable during rolling
 * upgrades. Versioned events are accepted exactly once and never regress a
 * document buffer to an older revision.
 */
export function shouldApplyMemoCommit(memoId: string, commit: MemoContentCommit): boolean {
  if (commit.revision === undefined || !commit.changeId) return true;
  const applied = appliedCommits.get(memoId);
  if (!applied) return true;
  if (applied.changeId === commit.changeId) return false;
  return commit.revision > applied.revision;
}

export function markMemoCommitApplied(memoId: string, commit: MemoContentCommit): void {
  if (commit.revision === undefined || !commit.changeId) return;
  const applied = appliedCommits.get(memoId);
  if (!applied || commit.revision >= applied.revision) {
    appliedCommits.set(memoId, {
      revision: commit.revision,
      changeId: commit.changeId,
    });
  }
}

export function newerPendingMemoCommit<T extends MemoContentCommit>(
  current: T | null,
  incoming: T,
): T {
  if (!current) return incoming;
  if (incoming.revision === undefined || current.revision === undefined) return incoming;
  return incoming.revision >= current.revision ? incoming : current;
}

export function resetMemoContentRevisionsForTests(): void {
  appliedCommits.clear();
}
