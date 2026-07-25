import { describe, expect, it } from 'vitest';
import {
  scrollSelectedItemIntoView,
} from '@features/editor/extensions/shared/scroll-selected-item';

function rect(top: number, bottom: number): DOMRect {
  return {
    x: 0,
    y: top,
    width: 100,
    height: bottom - top,
    top,
    right: 100,
    bottom,
    left: 0,
    toJSON: () => ({}),
  };
}

describe('scrollSelectedItemIntoView', () => {
  it('keeps visible items still and scrolls an exiting item with top padding', () => {
    const scroller = document.createElement('div');
    const item = document.createElement('button');
    scroller.append(item);
    Object.defineProperties(scroller, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 300 },
    });
    scroller.getBoundingClientRect = () => rect(100, 200);

    scroller.scrollTop = 50;
    item.getBoundingClientRect = () => rect(130, 150);
    scrollSelectedItemIntoView(scroller, item);
    expect(scroller.scrollTop).toBe(50);

    scroller.scrollTop = 0;
    item.getBoundingClientRect = () => rect(220, 244);
    scrollSelectedItemIntoView(scroller, item);
    expect(scroller.scrollTop).toBe(100);

    item.getBoundingClientRect = () => rect(400, 424);
    scrollSelectedItemIntoView(scroller, item);
    expect(scroller.scrollTop).toBe(200);
  });
});
