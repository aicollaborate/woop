import { describe, expect, it } from 'vitest';

import {
  computeNotebookDropPosition,
  reorderNotebookIds,
} from '@features/memo/components/notebook-reorder';

describe('computeNotebookDropPosition', () => {
  // 行高 24, top 100: 上半 [100,112) -> before, 下半 [112,124] -> after。
  it('returns "before" when pointer is in the upper half of the row', () => {
    expect(computeNotebookDropPosition(100, 100, 24)).toBe('before');
    expect(computeNotebookDropPosition(111, 100, 24)).toBe('before');
  });

  it('returns "after" when pointer is in the lower half (>= height/2)', () => {
    expect(computeNotebookDropPosition(112, 100, 24)).toBe('after');
    expect(computeNotebookDropPosition(124, 100, 24)).toBe('after');
  });

  it('treats the exact midpoint as "after" (< is before, so midpoint falls through)', () => {
    // height/2 = 12; y-top == 12 -> not < 12 -> after
    expect(computeNotebookDropPosition(112, 100, 24)).toBe('after');
  });
});

describe('reorderNotebookIds', () => {
  it('is a no-op (same ref) when source === target', () => {
    const ids = ['a', 'b', 'c'];
    expect(reorderNotebookIds(ids, 'a', 'a', 'before')).toBe(ids);
  });

  it('is a no-op (same ref) when source or target is missing', () => {
    const ids = ['a', 'b', 'c'];
    expect(reorderNotebookIds(ids, 'a', 'x', 'before')).toBe(ids);
    expect(reorderNotebookIds(ids, 'x', 'b', 'after')).toBe(ids);
  });

  it('moves source before a later target (sourceIndex < targetIndex index correction)', () => {
    // a(0) before c(2): splice a -> [b,c], sourceIndex<target -> insertAt=1, before -> 1 => [b,a,c]
    expect(reorderNotebookIds(['a', 'b', 'c', 'd'], 'a', 'c', 'before')).toEqual([
      'b', 'a', 'c', 'd',
    ]);
  });

  it('moves source after a later target', () => {
    // a(0) after c(2): insertAt=1, after -> 2 => [b,c,a,d]
    expect(reorderNotebookIds(['a', 'b', 'c', 'd'], 'a', 'c', 'after')).toEqual([
      'b', 'c', 'a', 'd',
    ]);
  });

  it('moves source before an earlier target (no index correction)', () => {
    // d(3) before b(1): splice d -> [a,b,c], sourceIndex>target -> insertAt=1, before -> 1 => [a,d,b,c]
    expect(reorderNotebookIds(['a', 'b', 'c', 'd'], 'd', 'b', 'before')).toEqual([
      'a', 'd', 'b', 'c',
    ]);
  });

  it('moves source after an earlier target', () => {
    // d(3) after b(1): insertAt=1, after -> 2 => [a,b,d,c]
    expect(reorderNotebookIds(['a', 'b', 'c', 'd'], 'd', 'b', 'after')).toEqual([
      'a', 'b', 'd', 'c',
    ]);
  });

  it('moves an adjacent source before its next sibling (net unchanged order)', () => {
    // b(1) before c(2): splice b -> [a,c,d], sourceIndex<target -> insertAt=1, before -> 1 => [a,b,c,d]
    expect(reorderNotebookIds(['a', 'b', 'c', 'd'], 'b', 'c', 'before')).toEqual([
      'a', 'b', 'c', 'd',
    ]);
  });

  it('moves an adjacent source after its previous sibling (net unchanged order)', () => {
    // b(1) after a(0): sourceIndex>target -> insertAt=0, after -> 1 => [a,b,c,d]
    expect(reorderNotebookIds(['a', 'b', 'c', 'd'], 'b', 'a', 'after')).toEqual([
      'a', 'b', 'c', 'd',
    ]);
  });

  it('moves source after a later target where source is just before target', () => {
    // b(1) after c(2): sourceIndex<target -> insertAt=1, after -> 2 => [a,c,b,d]
    expect(reorderNotebookIds(['a', 'b', 'c', 'd'], 'b', 'c', 'after')).toEqual([
      'a', 'c', 'b', 'd',
    ]);
  });

  it('clamps insertAt to the end when moving after the last item', () => {
    // a(0) after d(3): sourceIndex<target -> insertAt=2, after -> 3 => [b,c,d,a]
    expect(reorderNotebookIds(['a', 'b', 'c', 'd'], 'a', 'd', 'after')).toEqual([
      'b', 'c', 'd', 'a',
    ]);
  });

  it('clamps insertAt to the start when moving before the first item', () => {
    // d(3) before a(0): sourceIndex>target -> insertAt=0, before -> 0 => [d,a,b,c]
    expect(reorderNotebookIds(['a', 'b', 'c', 'd'], 'd', 'a', 'before')).toEqual([
      'd', 'a', 'b', 'c',
    ]);
  });

  it('does not mutate the input array', () => {
    const ids = ['a', 'b', 'c'];
    reorderNotebookIds(ids, 'a', 'c', 'before');
    expect(ids).toEqual(['a', 'b', 'c']);
  });
});
