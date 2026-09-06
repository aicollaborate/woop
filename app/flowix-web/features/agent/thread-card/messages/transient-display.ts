/**
 * Short-lived agent UI (run indicators and tool previews) should not appear
 * and disappear in the same render turn. Keeping it visible briefly makes
 * fast tools observable without delaying the actual message completion.
 */
export const MIN_TRANSIENT_DISPLAY_DURATION_MS = 1000;
export const TOOL_PREVIEW_EXIT_DURATION_MS = 800;
