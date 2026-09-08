import { afterEach, describe, expect, it, vi } from 'vitest';
import { invokeHandler, pushHandler } from './handler-registry';

describe('handler registry', () => {
  const pops: Array<() => void> = [];

  afterEach(() => {
    while (pops.length > 0) pops.pop()?.();
  });

  it('skips an unfocused top handler and invokes the focused instance', () => {
    const focused = vi.fn();
    const unfocused = vi.fn();
    let focusedState = true;

    pops.push(pushHandler('test.focus', focused, { isActive: () => focusedState }));
    pops.push(pushHandler('test.focus', unfocused, { isActive: () => false }));

    expect(invokeHandler('test.focus')).toBe(true);
    expect(focused).toHaveBeenCalledTimes(1);
    expect(unfocused).not.toHaveBeenCalled();

    focusedState = false;
    expect(invokeHandler('test.focus')).toBe(false);
  });

  it('preserves the existing top-handler behavior without an active predicate', () => {
    const handler = vi.fn();
    pops.push(pushHandler('test.default', handler));

    expect(invokeHandler('test.default')).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
