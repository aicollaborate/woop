import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoItem } from '@/types/memo-item';

import { MobileMemoList } from './mobile-memo-list';

const memo: MemoItem = {
  id: 'memo-1',
  filename: '跟手测试.md',
  preview: '测试横滑交互',
  tags: [],
  todos: [],
  agents: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  favorited: false,
  icon: null,
  colors: [],
  properties: {},
};

function pointer(type: string, x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: x },
    clientY: { value: y },
    pointerId: { value: 1 },
    pointerType: { value: 'touch' },
  });
  return event;
}

let container: HTMLDivElement;
let root: Root;

describe('MobileMemoList swipe actions', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
  });

  it('moves with the pointer before committing the open state', async () => {
    const onToggleActions = vi.fn();
    const onOpen = vi.fn();
    await act(async () => root.render(createElement(MobileMemoList, {
      items: [memo],
      loading: false,
      onRefresh: vi.fn(),
      onOpen,
      openMemoId: null,
      onToggleActions,
      onDelete: vi.fn(),
      onTogglePin: vi.fn(),
    })));

    const row = container.querySelector<HTMLButtonElement>('.mobile-memo-row');
    expect(row).not.toBeNull();
    const actions = container.querySelectorAll<HTMLButtonElement>('.mobile-memo-row-action');
    expect(actions).toHaveLength(2);
    expect(actions[0].textContent).toBe('');
    expect(actions[0].getAttribute('aria-label')).toBe('置顶');
    expect(actions[1].textContent).toBe('');
    expect(actions[1].getAttribute('aria-label')).toBe('删除');

    row!.dispatchEvent(pointer('pointerdown', 220, 100));
    row!.dispatchEvent(pointer('pointermove', 170, 100));

    expect(row!.style.getPropertyValue('--mobile-memo-row-offset')).toBe('-50px');
    expect(container.querySelector<HTMLElement>('.mobile-memo-row-shell')!.style.getPropertyValue('--mobile-memo-row-action-progress')).toBe('0.46296296296296297');
    expect(onToggleActions).not.toHaveBeenCalled();

    row!.dispatchEvent(pointer('pointerup', 170, 100));
    expect(onToggleActions).toHaveBeenCalledWith('memo-1');

    row!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onOpen).not.toHaveBeenCalled();
  });
});
