const interestCounts = new Map<string, number>();

export function acquireThreadInterest(threadId: string): () => void {
  const normalized = threadId.trim();
  if (!normalized) return () => undefined;
  interestCounts.set(normalized, (interestCounts.get(normalized) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (interestCounts.get(normalized) ?? 1) - 1;
    if (next > 0) interestCounts.set(normalized, next);
    else interestCounts.delete(normalized);
  };
}

export function hasThreadInterest(threadId: string): boolean {
  return (interestCounts.get(threadId) ?? 0) > 0;
}

export function getInterestedThreadIds(): string[] {
  return [...interestCounts.keys()];
}

/** Test-only reset; exported to keep the registry independently testable. */
export function resetThreadInterests(): void {
  interestCounts.clear();
}
