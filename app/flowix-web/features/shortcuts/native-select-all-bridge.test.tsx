import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NativeSelectAllBridge } from './native-select-all-bridge';

const mocks = vi.hoisted(() => ({
  actionRun: vi.fn(),
  getAction: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  listener: undefined as (() => void) | undefined,
}));

vi.mock('@/lib/shortcuts/registry', () => ({
  getAction: mocks.getAction,
}));
vi.mock('@/lib/shortcuts/platform', () => ({
  getPlatform: () => 'mac',
}));
vi.mock('@platform/tauri/event-bus', () => ({
  subscribe: mocks.subscribe,
}));

describe('NativeSelectAllBridge', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    mocks.actionRun.mockReset();
    mocks.getAction.mockReset().mockReturnValue({ run: mocks.actionRun });
    mocks.unsubscribe.mockReset();
    mocks.listener = undefined;
    mocks.subscribe.mockReset().mockImplementation((event: string, listener: () => void) => {
      expect(event).toBe('flowix://editor-select-all');
      mocks.listener = listener;
      return mocks.unsubscribe;
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<NativeSelectAllBridge />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('dispatches the editor select-all action with native menu context', () => {
    mocks.listener?.();

    expect(mocks.actionRun).toHaveBeenCalledWith({
      scope: 'editor',
      source: 'menu',
      platform: 'mac',
    });
  });

  it.each(['input', 'textarea'] as const)('selects a focused %s without dispatching the editor action', (tag) => {
    const field = document.createElement(tag);
    field.value = 'Flowix';
    document.body.appendChild(field);
    const select = vi.spyOn(field, 'select');
    field.focus();

    mocks.listener?.();

    expect(select).toHaveBeenCalledOnce();
    expect(mocks.actionRun).not.toHaveBeenCalled();
    field.remove();
  });

  it('is a safe no-op when the action is unavailable', () => {
    mocks.getAction.mockReturnValue(undefined);

    expect(() => mocks.listener?.()).not.toThrow();
    expect(mocks.actionRun).not.toHaveBeenCalled();
  });

  it('unsubscribes from the native event when unmounted', async () => {
    await act(async () => root.unmount());

    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    root = createRoot(container);
  });
});
