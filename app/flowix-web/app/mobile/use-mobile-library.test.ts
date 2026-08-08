import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CloudState, CloudSyncStatus, NotebookRecord, OpenMemoSession } from '@platform/tauri/mobile-client';
import type { MemoItem } from '@/types/memo-item';

// 共享 mock 状态: vi.hoisted 保证在 vi.mock 工厂执行时已就绪。
// listenToCloudStateChanges 的 handler 被捕获到 cloudListener, 让测试可以
// 模拟后端推送云状态变更 (触发 notebook 重载)。
const mocks = vi.hoisted(() => ({
  cloudListener: null as ((state: CloudState) => void) | null,
  syncStatusListener: null as ((status: CloudSyncStatus) => void) | null,
  unlisten: vi.fn(),
  initialize: vi.fn(),
  bootstrapCloud: vi.fn(),
  notebooksGetAll: vi.fn(),
  tagsGetAll: vi.fn(),
  memosGetMemos: vi.fn(),
  openMemoSession: vi.fn(),
  addDocument: vi.fn(),
  deleteMemo: vi.fn(),
  favoriteMemo: vi.fn(),
  unfavoriteMemo: vi.fn(),
  writeDocument: vi.fn(),
  cloudGetState: vi.fn(),
  cloudLogin: vi.fn(),
  cloudLogout: vi.fn(),
  cloudRefreshMembership: vi.fn(),
}));

vi.mock('@platform/tauri/mobile-client', () => ({
  mobileClient: {
    initialize: mocks.initialize,
    bootstrapCloud: mocks.bootstrapCloud,
    listenToCloudStateChanges: (handler: (state: CloudState) => void) => {
      mocks.cloudListener = handler;
      return mocks.unlisten;
    },
    listenToCloudSyncStatusChanges: (handler: (status: CloudSyncStatus) => void) => {
      mocks.syncStatusListener = handler;
      return mocks.unlisten;
    },
    cloud: {
      getState: mocks.cloudGetState,
      login: mocks.cloudLogin,
      logout: mocks.cloudLogout,
      refreshMembership: mocks.cloudRefreshMembership,
    },
    notebooks: { getAll: mocks.notebooksGetAll },
    tags: { getAll: mocks.tagsGetAll },
    memos: {
      getMemos: mocks.memosGetMemos,
      openMemoSession: mocks.openMemoSession,
      writeDocument: mocks.writeDocument,
      addDocument: mocks.addDocument,
      deleteMemo: mocks.deleteMemo,
      favoriteMemo: mocks.favoriteMemo,
      unfavoriteMemo: mocks.unfavoriteMemo,
    },
  },
}));

import { useMobileLibrary } from './use-mobile-library';

// ---- fixtures ----

function makeMemo(id: string, overrides: Partial<MemoItem> = {}): MemoItem {
  return {
    id,
    filename: `${id}.md`,
    preview: '',
    tags: [],
    todos: [],
    agents: [],
    createdAt: 1000,
    updatedAt: 2000,
    favorited: false,
    icon: null,
    colors: [],
    properties: {},
    ...overrides,
  };
}

function makeNotebook(id: string, name: string): NotebookRecord {
  return {
    id,
    name,
    icon: null,
    path: `/n/${id}/`,
    createdAt: 1000,
    updatedAt: 2000,
    isDefault: false,
    sort: 0,
  };
}

function cloudState(overrides: Partial<CloudState> = {}): CloudState {
  return {
    enabled: false,
    authenticated: false,
    account: null,
    membership: null,
    lastError: null,
    ...overrides,
  };
}

// 可同步的云状态: 已登录 + 启用 + 有效非只读订阅。
function syncableCloudState(): CloudState {
  return cloudState({
    authenticated: true,
    enabled: true,
    membership: {
      active: true,
      startsAt: null,
      expiresAt: null,
      usedBytes: 0,
      quotaBytes: 1024,
      availableBytes: 1024,
      noteCount: 0,
      readOnly: false,
    },
  });
}

// Harness: 把 hook 返回值落到模块级 latestLibrary, 让测试在 act 之外读取
// 字段、在 act 之内调用方法。每次 render 都刷新引用 (方法依赖最新 state)。
type Library = ReturnType<typeof useMobileLibrary>;
let latestLibrary: Library | null = null;

function Harness() {
  latestLibrary = useMobileLibrary();
  return createElement(
    'span',
    null,
    latestLibrary.booting
      ? 'booting'
      : `${latestLibrary.memoItems.length} memos`,
  );
}

// 让 jsdom 微任务队列排空 (hook 内部多处 async + Promise.all)。
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('useMobileLibrary', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cloudListener = null;
    mocks.syncStatusListener = null;

    // 默认: 本地未登录, 两个笔记本, nb1 有 1 篇 / nb2 有 2 篇。
    mocks.initialize.mockResolvedValue(cloudState());
    mocks.cloudGetState.mockResolvedValue(cloudState());
    mocks.notebooksGetAll.mockResolvedValue([
      makeNotebook('nb1', '日记'),
      makeNotebook('nb2', '工作'),
    ]);
    mocks.tagsGetAll.mockResolvedValue({ tags: [] });
    mocks.memosGetMemos.mockImplementation((params?: { notebookId?: string }) => {
      const notebookId = params?.notebookId;
      const memos = notebookId === 'nb2' ? [makeMemo('m2'), makeMemo('m3')] : [makeMemo('m1')];
      return Promise.resolve({ memos });
    });
    mocks.bootstrapCloud.mockResolvedValue({
      notebooks: 2, uploaded: 0, deleted: 0, downloaded: 0, conflicts: 0,
    });
    mocks.cloudLogout.mockResolvedValue(cloudState());
    mocks.openMemoSession.mockResolvedValue(null);
    mocks.addDocument.mockResolvedValue(makeMemo('m-new'));
    mocks.deleteMemo.mockResolvedValue(true);
    mocks.favoriteMemo.mockResolvedValue(true);
    mocks.unfavoriteMemo.mockResolvedValue(true);

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    latestLibrary = null;
    vi.useRealTimers();
  });

  async function renderAndWait() {
    await act(async () => {
      root.render(createElement(Harness));
      await flush();
    });
    // loadNotebook 走两次 (mount effect + selectedNotebookId effect), 排空。
    await act(async () => { await flush(); });
  }

  it('initializes: restores cloud state, loads notebooks + first notebook memos, clears booting', async () => {
    await renderAndWait();

    expect(mocks.initialize).toHaveBeenCalledOnce();
    // cloudState 来自 initialize(), 透传到 hook 输出。
    expect(latestLibrary?.booting).toBe(false);
    expect(latestLibrary?.selectedNotebookId).toBe('nb1');
    // 默认选第一个笔记本, 拉到 m1。
    expect(latestLibrary?.memoItems.map((memo) => memo.id)).toEqual(['m1']);
    expect(mocks.notebooksGetAll).toHaveBeenCalled();
    expect(mocks.memosGetMemos).toHaveBeenCalledWith(
      expect.objectContaining({ notebookId: 'nb1', sort: 'updatedAt' }),
    );
  });

  it('quick-switches notebooks: reloading tags + memos for the new notebook', async () => {
    await renderAndWait();
    expect(latestLibrary?.memoItems.map((memo) => memo.id)).toEqual(['m1']);

    const before = mocks.memosGetMemos.mock.calls.length;
    await act(async () => {
      latestLibrary?.selectNotebook('nb2');
      await flush();
    });

    expect(latestLibrary?.selectedNotebookId).toBe('nb2');
    expect(latestLibrary?.memoItems.map((memo) => memo.id)).toEqual(['m2', 'm3']);
    // 切换后用新 notebookId 拉取了一次。
    expect(mocks.memosGetMemos.mock.calls.length).toBeGreaterThan(before);
    expect(mocks.memosGetMemos).toHaveBeenCalledWith(
      expect.objectContaining({ notebookId: 'nb2' }),
    );
    expect(mocks.tagsGetAll).toHaveBeenCalledWith('nb2');
  });

  it('quick-switches tags: filters memos by tag and resets on "all"', async () => {
    await renderAndWait();
    mocks.tagsGetAll.mockResolvedValue({ tags: [{ id: 't1', name: 'AI' }] });
    mocks.memosGetMemos.mockResolvedValue({ memos: [makeMemo('m1', { tags: ['AI'] })] });

    await act(async () => {
      latestLibrary?.selectTag('t1');
      await flush();
    });

    expect(latestLibrary?.selectedTagId).toBe('t1');
    expect(mocks.memosGetMemos).toHaveBeenCalledWith(
      expect.objectContaining({ notebookId: 'nb1', filter: 'tagged', tagId: 't1' }),
    );

    // 切回"全部笔记"。
    await act(async () => {
      latestLibrary?.selectTag(null);
      await flush();
    });
    expect(latestLibrary?.selectedTagId).toBeNull();
    expect(mocks.memosGetMemos).toHaveBeenCalledWith(
      expect.objectContaining({ filter: 'all', tagId: undefined }),
    );
  });

  it('surfaces a sync failure as a message while still reporting a handled result', async () => {
    // 让 canSync = true, 否则 syncNow 直接 short-circuit 返回 false。
    mocks.cloudGetState.mockResolvedValue(syncableCloudState());
    mocks.bootstrapCloud.mockRejectedValue(new Error('网络中断'));

    await renderAndWait();
    // 把已登录状态灌进 hook (模拟 initialize 返回可同步状态)。
    await act(async () => { mocks.cloudListener?.(syncableCloudState()); await flush(); });

    expect(latestLibrary?.canSync).toBe(true);

    let result: boolean | undefined;
    await act(async () => {
      result = await latestLibrary?.syncNow();
      await flush();
    });

    // bootstrapCloud 被调, 失败被 catch: message 置为错误文案, syncing 复位。
    expect(mocks.bootstrapCloud).toHaveBeenCalledOnce();
    expect(latestLibrary?.syncing).toBe(false);
    expect(latestLibrary?.message).toBe('网络中断');
    // 当前契约: 失败也返回 true (不触发 mobile-app 强开账号面板, 仅留消息)。
    expect(result).toBe(true);
  });

  it('short-circuits syncNow when cloud sync is unavailable', async () => {
    await renderAndWait();
    expect(latestLibrary?.canSync).toBe(false);

    let result: boolean | undefined;
    await act(async () => {
      result = await latestLibrary?.syncNow();
      await flush();
    });

    expect(result).toBe(false);
    expect(mocks.bootstrapCloud).not.toHaveBeenCalled();
    expect(latestLibrary?.syncing).toBe(false);
  });

  it('coalesces concurrent sync requests into one backend run', async () => {
    let finishSync: (() => void) | null = null;
    mocks.bootstrapCloud.mockImplementation(() => new Promise((resolve) => {
      finishSync = () => resolve({
        notebooks: 2, uploaded: 0, deleted: 0, downloaded: 0, conflicts: 0,
      });
    }));
    mocks.cloudGetState.mockResolvedValue(syncableCloudState());
    await renderAndWait();
    await act(async () => { mocks.cloudListener?.(syncableCloudState()); await flush(); });

    await act(async () => {
      const first = latestLibrary?.syncNow();
      const second = latestLibrary?.syncNow();
      expect(mocks.bootstrapCloud).toHaveBeenCalledOnce();
      finishSync?.();
      await Promise.all([first, second]);
      await flush();
    });

    expect(mocks.bootstrapCloud).toHaveBeenCalledOnce();
    expect(latestLibrary?.syncing).toBe(false);
  });

  it('logs out via cloud.logout and refreshes cloud state', async () => {
    mocks.cloudLogout.mockResolvedValue(cloudState({ authenticated: false }));
    await renderAndWait();
    await act(async () => { mocks.cloudListener?.(syncableCloudState()); await flush(); });
    expect(latestLibrary?.cloudState?.authenticated).toBe(true);

    await act(async () => {
      await latestLibrary?.logout();
      await flush();
    });

    expect(mocks.cloudLogout).toHaveBeenCalledOnce();
    expect(latestLibrary?.cloudState?.authenticated).toBe(false);
  });

  it('reloads notebooks when the backend pushes a cloud-state change', async () => {
    await renderAndWait();
    expect(mocks.cloudListener).not.toBeNull();
    const before = mocks.notebooksGetAll.mock.calls.length;

    await act(async () => {
      mocks.cloudListener?.(syncableCloudState());
      await flush();
    });

    // 监听器触发后重载 notebook 列表 + memos。
    expect(mocks.notebooksGetAll.mock.calls.length).toBeGreaterThan(before);
    expect(latestLibrary?.cloudState?.authenticated).toBe(true);
  });

  it('exposes backend sync progress and failure details to the mobile UI', async () => {
    await renderAndWait();

    await act(async () => {
      mocks.syncStatusListener?.({
        notebookId: 'all', runId: 'run-1', state: 'syncing', phase: 'transfer',
        uploaded: 0, deleted: 0, downloaded: 0, startedAt: 1,
      });
      await flush();
    });
    expect(latestLibrary?.syncing).toBe(true);
    expect(latestLibrary?.syncStatus?.phase).toBe('transfer');

    await act(async () => {
      mocks.syncStatusListener?.({
        notebookId: 'all', runId: 'run-1', state: 'error', phase: 'retrying',
        uploaded: 0, deleted: 0, downloaded: 0, startedAt: 1, finishedAt: 2,
        lastError: '网络暂不可用',
      });
      await flush();
    });
    expect(latestLibrary?.syncing).toBe(false);
    expect(latestLibrary?.message).toBe('网络暂不可用');
  });

  it('opens a memo into an active document session', async () => {
    const session: OpenMemoSession = {
      memo: makeMemo('m1', { filename: 'm1.md' }),
      notebookId: 'nb1',
      notebookPath: '/n/nb1/',
      path: '/n/nb1/m1.md',
      content: '# Hello',
    };
    mocks.openMemoSession.mockResolvedValue(session);

    await renderAndWait();
    await act(async () => {
      await latestLibrary?.openMemo('m1');
      await flush();
    });

    expect(mocks.openMemoSession).toHaveBeenCalledWith('m1');
    expect(latestLibrary?.activeDocument).toBe(session);
  });

  it('leaves boot mode and reports an initialization failure', async () => {
    mocks.initialize.mockRejectedValue(new Error('本地数据无法读取'));

    await renderAndWait();

    expect(latestLibrary?.booting).toBe(false);
    expect(latestLibrary?.message).toBe('本地数据无法读取');
    expect(mocks.notebooksGetAll).not.toHaveBeenCalled();
  });

  it('reports missing and failed memo opens without replacing the current view', async () => {
    await renderAndWait();
    mocks.openMemoSession.mockResolvedValueOnce(null);

    await act(async () => {
      await latestLibrary?.openMemo('gone');
      await flush();
    });
    expect(latestLibrary?.activeDocument).toBeNull();
    expect(latestLibrary?.message).toContain('已不存在');

    mocks.openMemoSession.mockRejectedValueOnce(new Error('文件权限已撤销'));
    await act(async () => {
      await latestLibrary?.openMemo('m1');
      await flush();
    });
    expect(latestLibrary?.activeDocument).toBeNull();
    expect(latestLibrary?.message).toBe('文件权限已撤销');
  });

  it('creates a memo and opens the newly returned session', async () => {
    const session: OpenMemoSession = {
      memo: makeMemo('m-new'),
      notebookId: 'nb1',
      notebookPath: '/n/nb1/',
      path: '/n/nb1/m-new.md',
      content: '',
    };
    mocks.openMemoSession.mockResolvedValue(session);
    await renderAndWait();

    await act(async () => {
      await latestLibrary?.createMemo();
      await flush();
    });

    expect(mocks.addDocument).toHaveBeenCalledWith(undefined, 'nb1');
    expect(mocks.openMemoSession).toHaveBeenCalledWith('m-new');
    expect(latestLibrary?.activeDocument).toBe(session);
  });

  it('keeps the list consistent after a delete and reports a rejected delete', async () => {
    await renderAndWait();
    expect(latestLibrary?.memoItems.map((memo) => memo.id)).toEqual(['m1']);

    await act(async () => {
      await latestLibrary?.deleteMemo('m1');
      await flush();
    });
    expect(mocks.deleteMemo).toHaveBeenCalledWith('m1');
    expect(latestLibrary?.memoItems).toEqual([]);

    mocks.deleteMemo.mockResolvedValueOnce(false);
    await act(async () => {
      await latestLibrary?.deleteMemo('m2');
      await flush();
    });
    expect(latestLibrary?.message).toBe('删除笔记失败');
  });

  it('calls the matching favorite action and surfaces favorite failures', async () => {
    await renderAndWait();
    const regular = makeMemo('m1');
    const pinned = makeMemo('m2', { favorited: true });

    await act(async () => {
      await latestLibrary?.toggleMemoFavorite(regular);
      await flush();
      await latestLibrary?.toggleMemoFavorite(pinned);
      await flush();
    });
    expect(mocks.favoriteMemo).toHaveBeenCalledWith('m1');
    expect(mocks.unfavoriteMemo).toHaveBeenCalledWith('m2');

    mocks.favoriteMemo.mockResolvedValueOnce(false);
    await act(async () => {
      await latestLibrary?.toggleMemoFavorite(regular);
      await flush();
    });
    expect(latestLibrary?.message).toBe('置顶操作失败');
  });

  it('keeps the cloud account state when logout fails', async () => {
    mocks.cloudLogout.mockRejectedValue(new Error('注销请求失败'));
    await renderAndWait();
    await act(async () => { mocks.cloudListener?.(syncableCloudState()); await flush(); });

    let result: boolean | undefined;
    await act(async () => {
      result = await latestLibrary?.logout();
      await flush();
    });

    expect(result).toBe(false);
    expect(latestLibrary?.cloudState?.authenticated).toBe(true);
    expect(latestLibrary?.message).toBe('注销请求失败');
  });
});
