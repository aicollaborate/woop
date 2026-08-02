import {
  BookOpenText,
  CheckCircle2,
  Cloud,
  CloudOff,
  Hash,
  Layers3,
  LogIn,
  LogOut,
  Menu,
  NotebookPen,
  RefreshCw,
  SquarePen,
  Tags,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { MobileDocumentScreen } from './mobile-document-screen';
import {
  cloud,
  memos as memosClient,
  mobile,
  notebooks as notebooksClient,
  tags as tagsClient,
  type CloudState,
  type OpenMemoSession,
} from '@platform/tauri/client';
import type { Notebook } from '@features/memo';
import { NotebookIcon } from '@features/memo/components/notebook-icon';
import type { MemoItem } from '@/types/memo-item';
import '@/styles/mobile.css';

interface MobileTag {
  id: string;
  name: string;
}

function noteTitle(filename: string): string {
  return filename.replace(/\.(?:md|markdown)$/i, '') || '未命名笔记';
}

function relativeTime(timestamp: number): string {
  const delta = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days} 天前` : new Date(timestamp).toLocaleDateString();
}

function cloudSyncAvailable(state: CloudState | null): boolean {
  return Boolean(
    state?.authenticated
    && state.enabled
    && state.membership?.active
    && !state.membership.readOnly,
  );
}

interface AccountPanelProps {
  state: CloudState | null;
  onClose: () => void;
  onStateChange: (state: CloudState) => Promise<void>;
}

function AccountPanel({ state, onClose, onStateChange }: AccountPanelProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const authenticated = Boolean(state?.authenticated);
  const syncAvailable = cloudSyncAvailable(state);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!email.trim() || !password) return;
    setLoading(true);
    setError('');
    try {
      const next = await cloud.login(email.trim(), password);
      setPassword('');
      await onStateChange(next);
      if (cloudSyncAvailable(next)) {
        try {
          await mobile.bootstrapCloud();
          await onStateChange(await cloud.getState());
        } catch (reason) {
          setError(`登录成功，但首次同步失败：${reason instanceof Error ? reason.message : String(reason)}`);
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  const refreshMembership = async () => {
    setLoading(true);
    setError('');
    try {
      await cloud.refreshMembership();
      const next = await cloud.getState();
      await onStateChange(next);
      if (cloudSyncAvailable(next)) {
        try {
          await mobile.bootstrapCloud();
          await onStateChange(await cloud.getState());
        } catch (reason) {
          setError(`订阅有效，但同步失败：${reason instanceof Error ? reason.message : String(reason)}`);
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mobile-account-layer" role="presentation">
      <button type="button" className="mobile-drawer-backdrop" aria-label="关闭账号面板" onClick={onClose} />
      <section className="mobile-account-sheet" aria-label="账号与云同步">
        <header>
          <div><strong>账号与云同步</strong><span>本地功能无需登录即可使用</span></div>
          <button type="button" className="mobile-icon-button" aria-label="关闭账号面板" onClick={onClose}><X size={20} /></button>
        </header>

        {!authenticated ? (
          <>
            <div className="mobile-local-mode-card">
              <span className="mobile-local-mode-card__icon"><CloudOff size={19} /></span>
              <div><strong>正在本地使用</strong><span>笔记保存在此设备，不会上传。</span></div>
            </div>
            <form className="mobile-account-form" onSubmit={(event) => void submit(event)}>
              <label>
                邮箱
                <input autoComplete="email" inputMode="email" value={email} onChange={(event) => setEmail(event.target.value)} />
              </label>
              <label>
                密码
                <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
              </label>
              {error && <div className="mobile-auth-error">{error}</div>}
              <button type="submit" disabled={loading || !email.trim() || !password}>
                <LogIn size={17} />{loading ? '登录中…' : '登录已有账号'}
              </button>
            </form>
          </>
        ) : (
          <div className="mobile-membership-card">
            <div className="mobile-membership-card__heading">
              <div><strong>{state?.account?.user.email}</strong><span>Flowix Cloud</span></div>
              <span className={syncAvailable ? 'is-active' : undefined}>
                {syncAvailable ? '云同步已开启' : '仅本地'}
              </span>
            </div>
            {syncAvailable ? (
              <p>订阅有效，笔记将在此设备与 Flowix Cloud 之间同步。</p>
            ) : state?.membership?.readOnly ? (
              <p>当前云空间为只读状态，请检查订阅或存储配额。本地编辑不受影响。</p>
            ) : (
              <p>当前账号尚未开通有效订阅。可在桌面端“设置 → 云同步”中选择方案，开通前仍可继续本地使用。</p>
            )}
            {error && <div className="mobile-auth-error">{error}</div>}
            <button type="button" disabled={loading} onClick={() => void refreshMembership()}>
              <RefreshCw size={17} className={loading ? 'is-spinning' : undefined} />
              {loading ? '检查中…' : '重新检查订阅状态'}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

export function MobileApp() {
  const [booting, setBooting] = useState(true);
  const [cloudState, setCloudState] = useState<CloudState | null>(null);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [selectedNotebookId, setSelectedNotebookId] = useState<string | null>(null);
  const [tags, setTags] = useState<MobileTag[]>([]);
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [memoItems, setMemoItems] = useState<MemoItem[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [activeDocument, setActiveDocument] = useState<OpenMemoSession | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [message, setMessage] = useState('');
  const canSync = cloudSyncAvailable(cloudState);

  const selectedNotebook = useMemo(
    () => notebooks.find((notebook) => notebook.id === selectedNotebookId) ?? null,
    [notebooks, selectedNotebookId],
  );
  const selectedTag = useMemo(
    () => tags.find((tag) => tag.id === selectedTagId) ?? null,
    [selectedTagId, tags],
  );

  const loadNotebooks = useCallback(async () => {
    const next = await notebooksClient.getAll();
    setNotebooks(next);
    setSelectedNotebookId((current) => (
      current && next.some((notebook) => notebook.id === current) ? current : next[0]?.id ?? null
    ));
  }, []);

  const loadCurrentNotebook = useCallback(async () => {
    if (!selectedNotebookId) {
      setTags([]);
      setMemoItems([]);
      return;
    }
    setLoadingList(true);
    try {
      const [tagResponse, memoResponse] = await Promise.all([
        tagsClient.getAll(selectedNotebookId),
        memosClient.getMemos({
          notebookId: selectedNotebookId,
          filter: selectedTagId ? 'tagged' : 'all',
          sort: 'updatedAt',
          tagId: selectedTagId || undefined,
        }),
      ]);
      setTags(tagResponse.tags);
      setMemoItems(memoResponse.memos);
    } finally {
      setLoadingList(false);
    }
  }, [selectedNotebookId, selectedTagId]);

  useEffect(() => {
    void (async () => {
      try {
        const state = await mobile.initialize();
        setCloudState(state);
        await loadNotebooks();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setBooting(false);
      }
    })();
  }, [loadNotebooks]);

  useEffect(() => {
    void loadCurrentNotebook();
  }, [loadCurrentNotebook]);

  const refresh = useCallback(async () => {
    if (!canSync) {
      setAccountOpen(true);
      return;
    }
    setSyncing(true);
    setMessage('');
    try {
      await mobile.bootstrapCloud();
      await loadNotebooks();
      await loadCurrentNotebook();
      setCloudState(await cloud.getState());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSyncing(false);
    }
  }, [canSync, loadCurrentNotebook, loadNotebooks]);

  const handleCloudStateChange = useCallback(async (next: CloudState) => {
    setCloudState(next);
    await loadNotebooks();
  }, [loadNotebooks]);

  const selectNotebook = (id: string) => {
    setSelectedNotebookId(id);
    setSelectedTagId(null);
    setDrawerOpen(false);
  };

  const selectTag = (id: string | null) => {
    setSelectedTagId(id);
    setDrawerOpen(false);
  };

  const openMemo = async (id: string) => {
    const session = await memosClient.openMemoSession(id);
    if (session) setActiveDocument(session);
  };

  const createMemo = async () => {
    if (!selectedNotebookId) return;
    const memo = await memosClient.addDocument(selectedTagId || undefined, selectedNotebookId);
    if (memo.id) await openMemo(memo.id);
  };

  const logout = async () => {
    setCloudState(await cloud.logout());
    setDrawerOpen(false);
    setAccountOpen(false);
  };

  if (booting) {
    return <main className="mobile-boot-screen"><span className="mobile-pulse-mark">F</span><p>正在准备笔记…</p></main>;
  }

  if (activeDocument) {
    return (
      <MobileDocumentScreen
        memoId={activeDocument.memo.id}
        filename={activeDocument.memo.filename}
        content={activeDocument.content}
        onBack={() => {
          setActiveDocument(null);
          void loadCurrentNotebook();
        }}
      />
    );
  }

  return (
    <main className="mobile-shell">
      <header className="mobile-topbar">
        <button type="button" className="mobile-icon-button" aria-label="打开导航" onClick={() => setDrawerOpen(true)}>
          <Menu size={21} strokeWidth={1.8} />
        </button>
        <div className="mobile-list-heading">
          <div><span className="mobile-heading-mark" aria-hidden="true" /><strong>{selectedTag?.name || selectedNotebook?.name || '笔记'}</strong></div>
          <span>{selectedTag ? '标签' : '笔记本'} · {memoItems.length} 篇</span>
        </div>
        <button type="button" className="mobile-icon-button" aria-label={canSync ? '同步' : '账号与云同步'} disabled={syncing} onClick={() => void refresh()}>
          {canSync
            ? <RefreshCw size={19} strokeWidth={1.8} className={syncing ? 'is-spinning' : undefined} />
            : <CloudOff size={19} strokeWidth={1.8} />}
        </button>
      </header>

      {message && <button type="button" className="mobile-message" onClick={() => setMessage('')}>{message}</button>}

      <section className="mobile-memo-list" aria-busy={loadingList}>
        {loadingList && memoItems.length === 0 ? (
          <div className="mobile-empty-state">正在加载…</div>
        ) : memoItems.length === 0 ? (
          <div className="mobile-empty-state"><BookOpenText size={30} /><strong>这里还没有笔记</strong><span>点击右下角开始记录</span></div>
        ) : memoItems.map((memo) => (
          <button type="button" className="mobile-memo-row" key={memo.id} onClick={() => void openMemo(memo.id)}>
            <div className="mobile-memo-row__title">
              <strong>{noteTitle(memo.filename)}</strong>
              <time>{relativeTime(memo.updatedAt)}</time>
            </div>
            {memo.preview && <p>{memo.preview}</p>}
            <div className="mobile-memo-row__meta">
              {memo.tags.slice(0, 3).map((tag) => <span className="is-tag" key={tag}>#{tag}</span>)}
              {memo.agents.length > 0 && <span className="is-agent">Agent {memo.agents.length}</span>}
              {memo.todos.length > 0 && <span className="is-todo"><CheckCircle2 size={10} />待办 {memo.todos.length}</span>}
            </div>
          </button>
        ))}
      </section>

      <button type="button" className="mobile-fab" aria-label="新建笔记" disabled={!selectedNotebookId} onClick={() => void createMemo()}>
        <SquarePen size={21} strokeWidth={1.8} />
      </button>

      {drawerOpen && (
        <div className="mobile-drawer-layer" role="presentation">
          <button type="button" className="mobile-drawer-backdrop" aria-label="关闭导航" onClick={() => setDrawerOpen(false)} />
          <aside className="mobile-drawer" aria-label="笔记导航">
            <div className="mobile-drawer-header">
              <div className="mobile-drawer-brand">
                <span className="mobile-brand-mark" aria-hidden="true"><span /></span>
                <div><strong>Flowix</strong><span>{cloudState?.authenticated ? cloudState.account?.user.email : '安静地留在本地'}</span></div>
              </div>
              <button type="button" className="mobile-icon-button" aria-label="关闭导航" onClick={() => setDrawerOpen(false)}><X size={20} /></button>
            </div>

            <nav className="mobile-drawer-content">
              <section>
                <h2><NotebookPen size={14} /> 笔记本</h2>
                {notebooks.map((notebook) => (
                  <button
                    type="button"
                    key={notebook.id}
                    className={notebook.id === selectedNotebookId ? 'is-selected' : undefined}
                    onClick={() => selectNotebook(notebook.id)}
                  >
                    <NotebookIcon icon={notebook.icon} name={notebook.name} className="mobile-notebook-icon" />
                    <span className="mobile-nav-label">{notebook.name}</span>
                  </button>
                ))}
              </section>

              <section>
                <h2><Tags size={14} /> 标签</h2>
                <button type="button" className={!selectedTagId ? 'is-selected' : undefined} onClick={() => selectTag(null)}>
                  <span className="mobile-nav-icon"><Layers3 size={16} /></span><span className="mobile-nav-label">全部笔记</span>
                </button>
                {tags.map((tag) => (
                  <button
                    type="button"
                    key={tag.id}
                    className={tag.id === selectedTagId ? 'is-selected' : undefined}
                    style={{ paddingInlineStart: `${14 + Math.min(3, tag.name.split('/').length - 1) * 14}px` }}
                    onClick={() => selectTag(tag.id)}
                  >
                    <span className="mobile-nav-icon"><Hash size={15} /></span><span className="mobile-nav-label">{tag.name.split('/').slice(-1)[0]}</span>
                  </button>
                ))}
              </section>
            </nav>

            <div className="mobile-drawer-account">
              <button type="button" onClick={() => { setDrawerOpen(false); setAccountOpen(true); }}>
                <span className={`mobile-cloud-status ${canSync ? 'is-online' : ''}`}>
                  {canSync ? <Cloud size={16} /> : <CloudOff size={16} />}
                </span>
                <span><strong>{canSync ? '云同步已开启' : '本地模式'}</strong><small>{cloudState?.authenticated ? '查看订阅状态' : '登录并订阅后同步'}</small></span>
              </button>
              {cloudState?.account && (
                <button type="button" className="mobile-logout-button" onClick={() => void logout()}><LogOut size={17} />退出登录</button>
              )}
            </div>
          </aside>
        </div>
      )}

      {accountOpen && (
        <AccountPanel
          state={cloudState}
          onClose={() => setAccountOpen(false)}
          onStateChange={handleCloudStateChange}
        />
      )}
    </main>
  );
}
