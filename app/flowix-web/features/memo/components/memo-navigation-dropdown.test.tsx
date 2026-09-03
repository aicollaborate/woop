import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MemoNavigationDropdown,
  MemoNavigationSubmenu,
} from './memo-navigation-dropdown';
import { DropdownMenuItem } from '@shared/ui/dropdown-menu';

describe('memo navigation dropdown', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('renders a submenu without requiring an implicit DropdownMenu context', async () => {
    const onClick = vi.fn();
    const onCloseMenu = vi.fn();

    await act(async () => {
      root.render(
        <MemoNavigationSubmenu
          label="Tags"
          open={false}
          emptyText="No tags"
          loadingText="Loading"
          onOpenChange={vi.fn()}
          onClick={onClick}
          onCloseMenu={onCloseMenu}
        />,
      );
    });

    const trigger = host.querySelector('button');
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(onClick).toHaveBeenCalledOnce();
    expect(onCloseMenu).toHaveBeenCalledOnce();
  });

  it('opens the middle-column navigation menu and keeps its items in menu context', async () => {
    await act(async () => {
      root.render(
        <MemoNavigationDropdown title="All notes" ariaLabel="Open navigation">
          <DropdownMenuItem onClick={vi.fn()}>Custom action</DropdownMenuItem>
        </MemoNavigationDropdown>,
      );
    });

    const trigger = host.querySelector('button[aria-label="Open navigation"]');
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(document.body.textContent).toContain('Custom action');
  });
});
