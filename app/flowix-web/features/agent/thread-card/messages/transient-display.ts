/**
 * Short-lived agent run indicators should not appear and disappear in the same
 * render turn. Keeping them visible briefly makes fast runs observable without
 * delaying the actual message completion.
 */
export const MIN_TRANSIENT_DISPLAY_DURATION_MS = 1000;
