import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Popover, PopoverContent, PopoverTrigger } from './popover';

let container: HTMLDivElement;
let root: Root;
let nextAnimationFrame: FrameRequestCallback | null;
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function TestPopover({ open, onExitComplete }: { open: boolean; onExitComplete?: () => void }) {
  return (
    <Popover open={open} onOpenChange={vi.fn()}>
      <PopoverTrigger asChild>
        <button type="button">Toggle</button>
      </PopoverTrigger>
      <PopoverContent onExitComplete={onExitComplete}>Content</PopoverContent>
    </Popover>
  );
}

describe('PopoverContent motion lifecycle', () => {
  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    nextAnimationFrame = null;

    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      nextAnimationFrame = callback;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false }));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it('positions before entering and stays mounted until the exit animation ends', async () => {
    const onExitComplete = vi.fn();
    await act(async () => root.render(createElement(TestPopover, { open: false, onExitComplete })));
    expect(document.body.querySelector('.flowix-popover-content')).toBeNull();

    await act(async () => root.render(createElement(TestPopover, { open: true, onExitComplete })));
    const startingContent = document.body.querySelector<HTMLElement>('.flowix-popover-content');
    expect(startingContent?.dataset.motionState).toBe('starting');
    expect(startingContent?.style.top).toBe('4px');

    await act(async () => nextAnimationFrame?.(16));
    expect(startingContent?.dataset.motionState).toBe('open');

    await act(async () => root.render(createElement(TestPopover, { open: false, onExitComplete })));
    const closingContent = document.body.querySelector<HTMLElement>('.flowix-popover-content');
    expect(closingContent?.dataset.motionState).toBe('closing');

    await act(async () => vi.advanceTimersByTime(499));
    expect(document.body.querySelector('.flowix-popover-content')).not.toBeNull();

    await act(async () => vi.advanceTimersByTime(1));
    expect(document.body.querySelector('.flowix-popover-content')).toBeNull();
    expect(onExitComplete).toHaveBeenCalledOnce();
  });
});
