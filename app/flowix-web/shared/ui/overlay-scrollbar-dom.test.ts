import { describe, expect, it } from 'vitest';
import { createOverlayScrollbarDom } from './overlay-scrollbar-dom';

describe('createOverlayScrollbarDom', () => {
  it('syncs the overlay thumb geometry from the scroller', () => {
    const overlay = createOverlayScrollbarDom(document);
    Object.defineProperties(overlay.scroller, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    });

    overlay.update({ reveal: false, schedule: false });

    expect(overlay.frame.dataset.scrollable).toBe('true');
    expect(overlay.frame.style.getPropertyValue('--overlay-scrollbar-thumb-height')).toBe('25px');
    expect(overlay.frame.style.getPropertyValue('--overlay-scrollbar-thumb-top')).toBe('25px');
    overlay.destroy();
  });
});
