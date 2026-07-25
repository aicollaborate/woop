import { describe, expect, it } from 'vitest';

import { hasExceededDragThreshold } from '@features/memo/hooks/use-drag-reorder';

describe('hasExceededDragThreshold', () => {
  // 语义: 原内联 `if (dy < threshold && dx < threshold) return;` 的反向 ──
  // 任一方向达到阈值即视为超过 (开始拖动)。

  it('returns false when both axes are below the threshold', () => {
    expect(hasExceededDragThreshold(0, 0, 4)).toBe(false);
    expect(hasExceededDragThreshold(3, 3, 4)).toBe(false);
    expect(hasExceededDragThreshold(3, 0, 4)).toBe(false);
    expect(hasExceededDragThreshold(0, 3, 4)).toBe(false);
  });

  it('returns true when the vertical axis reaches the threshold (>=)', () => {
    expect(hasExceededDragThreshold(4, 0, 4)).toBe(true);
    expect(hasExceededDragThreshold(5, 0, 4)).toBe(true);
  });

  it('returns true when the horizontal axis reaches the threshold (>=)', () => {
    expect(hasExceededDragThreshold(0, 4, 4)).toBe(true);
    expect(hasExceededDragThreshold(0, 5, 4)).toBe(true);
  });

  it('returns true when both axes reach the threshold', () => {
    expect(hasExceededDragThreshold(4, 4, 4)).toBe(true);
  });

  it('treats the threshold as an inclusive lower bound (exactly threshold == exceeded)', () => {
    // 3 < 4 -> not exceeded; 4 >= 4 -> exceeded. 边界在阈值本身。
    expect(hasExceededDragThreshold(3, 3, 4)).toBe(false);
    expect(hasExceededDragThreshold(4, 3, 4)).toBe(true);
    expect(hasExceededDragThreshold(3, 4, 4)).toBe(true);
  });

  it('respects a custom threshold', () => {
    expect(hasExceededDragThreshold(9, 9, 10)).toBe(false);
    expect(hasExceededDragThreshold(10, 0, 10)).toBe(true);
  });
});
