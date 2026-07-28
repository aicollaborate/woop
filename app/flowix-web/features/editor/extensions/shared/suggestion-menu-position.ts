export const SUGGESTION_MENU_VIEWPORT_PADDING = 8;

export function clampSuggestionMenuLeft(
  anchorLeft: number,
  menuWidth: number,
  viewportWidth: number,
  padding = SUGGESTION_MENU_VIEWPORT_PADDING,
): number {
  return Math.min(
    Math.max(anchorLeft, padding),
    Math.max(padding, viewportWidth - menuWidth - padding),
  );
}
