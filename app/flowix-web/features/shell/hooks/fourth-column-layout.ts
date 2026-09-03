import {
  FOURTH_COLUMN_DEFAULT_SPLIT_RATIO,
  FOURTH_COLUMN_MIN_WIDTH,
} from '@features/workspace/store/fourth-column-store';

export interface FourthColumnLayoutInput {
  viewportWidth: number;
  noteNavigationWidth: number;
  memoListWidth: number;
  memoListVisible: boolean;
  dividerCount: number;
  splitRatio: number;
}

export interface FourthColumnLayoutResult {
  canSplit: boolean;
  availableDocumentWidth: number;
  mainColumnWidth: number;
  fourthColumnWidth: number;
}

export function resolveFourthColumnLayout({
  viewportWidth,
  noteNavigationWidth,
  memoListWidth,
  memoListVisible,
  dividerCount,
  splitRatio,
}: FourthColumnLayoutInput): FourthColumnLayoutResult {
  const fixedLeftWidth = noteNavigationWidth
    + (memoListVisible ? memoListWidth : 0)
    + dividerCount;
  const availableDocumentWidth = Math.max(0, viewportWidth - fixedLeftWidth);
  const canSplit = availableDocumentWidth >= FOURTH_COLUMN_MIN_WIDTH * 2;

  if (!canSplit) {
    return {
      canSplit: false,
      availableDocumentWidth,
      mainColumnWidth: FOURTH_COLUMN_MIN_WIDTH,
      fourthColumnWidth: FOURTH_COLUMN_MIN_WIDTH,
    };
  }

  const minimumRatio = FOURTH_COLUMN_MIN_WIDTH / availableDocumentWidth;
  const clampedRatio = Math.min(
    1 - minimumRatio,
    Math.max(
      minimumRatio,
      Number.isFinite(splitRatio) ? splitRatio : FOURTH_COLUMN_DEFAULT_SPLIT_RATIO,
    ),
  );
  const fourthColumnWidth = availableDocumentWidth * clampedRatio;
  return {
    canSplit,
    availableDocumentWidth,
    mainColumnWidth: availableDocumentWidth - fourthColumnWidth,
    fourthColumnWidth,
  };
}
