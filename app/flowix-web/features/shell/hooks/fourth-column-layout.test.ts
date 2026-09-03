import { describe, expect, it } from 'vitest';
import { resolveFourthColumnLayout } from './fourth-column-layout';

const base = {
  noteNavigationWidth: 220,
  memoListWidth: 320,
  memoListVisible: true,
  dividerCount: 3,
  splitRatio: 0.5,
};

describe('resolveFourthColumnLayout', () => {
  it('keeps both document columns in the flex row when they fit', () => {
    expect(resolveFourthColumnLayout({ ...base, viewportWidth: 1440 })).toMatchObject({
      canSplit: true,
      availableDocumentWidth: 897,
      mainColumnWidth: 448.5,
      fourthColumnWidth: 448.5,
    });
  });

  it('keeps both panes side by side at their minimum widths when space is tight', () => {
    expect(resolveFourthColumnLayout({ ...base, viewportWidth: 1200 })).toMatchObject({
      canSplit: false,
      availableDocumentWidth: 657,
      mainColumnWidth: 360,
      fourthColumnWidth: 360,
    });
  });

  it('does not reserve a hidden memo list', () => {
    expect(resolveFourthColumnLayout({ ...base, viewportWidth: 1200, memoListVisible: false })).toMatchObject({
      canSplit: true,
      availableDocumentWidth: 977,
    });
  });

  it('preserves a dragged ratio while the window resizes', () => {
    const layout = resolveFourthColumnLayout({
      ...base,
      viewportWidth: 2000,
      splitRatio: 0.35,
    });

    expect(layout.canSplit).toBe(true);
    expect(layout.fourthColumnWidth / layout.availableDocumentWidth).toBeCloseTo(0.35);
    expect(layout.mainColumnWidth / layout.availableDocumentWidth).toBeCloseTo(0.65);
  });

  it('clamps both panes to the same minimum width at the split boundary', () => {
    const layout = resolveFourthColumnLayout({
      ...base,
      viewportWidth: 1263,
      splitRatio: 0.2,
    });

    expect(layout.canSplit).toBe(true);
    expect(layout.mainColumnWidth).toBe(360);
    expect(layout.fourthColumnWidth).toBe(360);
  });
});
