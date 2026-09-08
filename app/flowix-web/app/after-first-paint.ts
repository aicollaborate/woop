/**
 * Schedule non-critical startup work after the first paint, with a bounded
 * fallback for WebViews that do not expose requestIdleCallback.
 *
 * Security, persistence, permission, watcher, and event-bridge setup must not
 * use this scheduler: those services need to be ready before interaction.
 */
export function scheduleAfterFirstPaint(task: () => void): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let idleCallback: number | undefined;

  const frame = window.requestAnimationFrame(() => {
    if (cancelled) return;
    if ('requestIdleCallback' in window) {
      idleCallback = window.requestIdleCallback(() => {
        if (!cancelled) task();
      }, { timeout: 1_500 });
      return;
    }
    timer = globalThis.setTimeout(() => {
      if (!cancelled) task();
    }, 0);
  });

  return () => {
    cancelled = true;
    window.cancelAnimationFrame(frame);
    if (idleCallback !== undefined && 'cancelIdleCallback' in window) {
      window.cancelIdleCallback(idleCallback);
    }
    if (timer !== undefined) globalThis.clearTimeout(timer);
  };
}
