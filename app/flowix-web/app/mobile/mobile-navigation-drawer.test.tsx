import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MobileNavigationDrawer } from './mobile-navigation-drawer';
import type { CloudState } from '@platform/tauri/mobile-client';
import { mobileClient } from '@platform/tauri/mobile-client';

let container: HTMLDivElement;
let root: Root;

const notebook = {
  id: 'nb_1',
  name: '我的笔记',
  icon: null,
  memoCount: 48,
  path: '/notebooks/nb_1/',
  createdAt: 1,
  updatedAt: 1,
  isDefault: true,
  sort: 10,
};

const renderDrawer = (notebooks = [notebook]) => {
  root.render(createElement(MobileNavigationDrawer, {
    cloudState: null,
    notebooks,
    selectedNotebookId: notebook.id,
    selectedTagId: null,
    tags: [],
    onAccount: vi.fn(),
    onClose: vi.fn(),
    onLogout: vi.fn(),
    onSelectNotebook: vi.fn(),
    onSelectTag: vi.fn(),
    onCreateNotebook: vi.fn(),
    onDeleteNotebook: vi.fn().mockResolvedValue(true),
    onRenameNotebook: vi.fn(),
  }));
};

const authenticatedCloudState: CloudState = {
  enabled: true,
  authenticated: true,
  account: {
    user: {
      id: 'user_1',
      email: 'hello@flowix.app',
      displayName: 'Flowix 用户',
      systemRole: 'user',
    },
    protocolEpoch: 2,
  },
  membership: null,
};

describe('MobileNavigationDrawer notebook actions', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
  });

  it('opens notebook actions from the ellipsis button', async () => {
    await act(async () => renderDrawer([notebook, { ...notebook, id: 'nb_2', name: '工作' }]));

    expect(container.querySelector('.mobile-notebook-grid')).not.toBeNull();
    expect(container.querySelector('.mobile-notebook-card__count')?.textContent).toBe('48 篇');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="更多我的笔记操作"]')?.click();
    });

    expect(document.body.textContent).toContain('编辑');
    expect(document.body.textContent).toContain('删除');
    expect(document.body.querySelector('.mobile-notebook-menu')).not.toBeNull();
  });

  it('uses the native action alert on iOS', async () => {
    const originalUserAgent = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    });
    const showNotebookActions = vi.spyOn(mobileClient, 'showNotebookActions').mockResolvedValue();

    try {
      await act(async () => renderDrawer());
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[aria-label="更多我的笔记操作"]')?.click();
      });

      expect(showNotebookActions).toHaveBeenCalledWith('nb_1', '我的笔记');
      expect(container.querySelector('.mobile-notebook-menu')).toBeNull();
      await act(async () => {
        window.dispatchEvent(new CustomEvent('flowix-native-notebook-action', {
          detail: { id: 'nb_1', action: 'edit' },
        }));
      });
      expect(container.querySelector('form.mobile-notebook-dialog')?.textContent).toContain('重命名笔记本');
    } finally {
      showNotebookActions.mockRestore();
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true,
        value: originalUserAgent,
      });
    }
  });

  it('opens an in-app confirmation dialog from the dropdown delete action', async () => {
    await act(async () => renderDrawer([notebook, { ...notebook, id: 'nb_2', name: '工作' }]));

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="更多我的笔记操作"]')?.click();
    });
    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('.mobile-notebook-menu__item')]
        .find((button) => button.textContent?.includes('删除'))
        ?.click();
    });

    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('删除笔记本？');
    expect(container.textContent).toContain('“我的笔记”及其中的全部笔记会从此设备删除');
    expect(container.querySelector<HTMLButtonElement>('.mobile-notebook-dialog__danger')?.textContent).toBe('删除');
  });

  it('explains why the last notebook cannot be deleted', async () => {
    await act(async () => renderDrawer());

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="更多我的笔记操作"]')?.click();
    });
    await act(async () => {
      [...document.body.querySelectorAll<HTMLButtonElement>('.mobile-notebook-menu__item')]
        .find((button) => button.textContent?.includes('删除'))
        ?.click();
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('至少保留一个笔记本，不能删除。');
    expect(container.querySelector('.mobile-notebook-dialog__danger')).toBeNull();
  });
});

describe('MobileNavigationDrawer account header', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
  });

  it('shows the authenticated account name in the drawer header', async () => {
    await act(async () => {
      root.render(createElement(MobileNavigationDrawer, {
        cloudState: authenticatedCloudState,
        notebooks: [notebook],
        selectedNotebookId: notebook.id,
        selectedTagId: null,
        tags: [],
        onAccount: vi.fn(),
        onClose: vi.fn(),
        onLogout: vi.fn(),
        onSelectNotebook: vi.fn(),
        onSelectTag: vi.fn(),
        onCreateNotebook: vi.fn(),
        onDeleteNotebook: vi.fn().mockResolvedValue(true),
        onRenameNotebook: vi.fn(),
      }));
    });

    const accountButton = container.querySelector<HTMLButtonElement>('.mobile-drawer-account > button:first-child');
    expect(accountButton?.textContent).toContain('Flowix 用户');
    expect(accountButton?.textContent).toContain('0MB / 0MB');
    expect(accountButton?.getAttribute('aria-label')).toBe('账号：Flowix 用户，0MB / 0MB');
    expect(accountButton?.querySelector('.mobile-drawer-account__icon')).toBeNull();
    expect(container.querySelector('.mobile-drawer-header')?.contains(accountButton ?? null)).toBe(true);
  });

  it('shows the cloud storage usage under the account name', async () => {
    await act(async () => {
      root.render(createElement(MobileNavigationDrawer, {
        cloudState: {
          ...authenticatedCloudState,
          membership: { active: true, usedBytes: 5 * 1024 * 1024, quotaBytes: 200 * 1024 * 1024, availableBytes: 195 * 1024 * 1024, noteCount: 0, readOnly: false },
        },
        notebooks: [notebook],
        selectedNotebookId: notebook.id,
        selectedTagId: null,
        tags: [],
        onAccount: vi.fn(),
        onClose: vi.fn(),
        onLogout: vi.fn(),
        onSelectNotebook: vi.fn(),
        onSelectTag: vi.fn(),
        onCreateNotebook: vi.fn(),
        onDeleteNotebook: vi.fn().mockResolvedValue(true),
        onRenameNotebook: vi.fn(),
      }));
    });

    expect(container.querySelector('.mobile-drawer-account small')?.textContent).toBe('5.0 MB / 200 MB');
  });

  it('shows the login prompt when signed out', async () => {
    await act(async () => renderDrawer());

    const accountButton = container.querySelector<HTMLButtonElement>('.mobile-drawer-account > button:first-child');
    expect(accountButton?.textContent).toContain('未登录');
    expect(accountButton?.textContent).toContain('点击登录并云同步');
    expect(accountButton?.getAttribute('aria-label')).toBe('未登录，点击登录并云同步');
    expect(accountButton?.querySelector('.mobile-drawer-account__icon')).toBeNull();
  });
});
