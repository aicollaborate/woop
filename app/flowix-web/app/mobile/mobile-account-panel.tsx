import { BookOpen, CloudOff, HardDrive, LogIn, LogOut, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type TouchEvent } from 'react';

import packageJson from '../../../../package.json';

import { cloudSyncAvailable } from './mobile-model';
import { mobileErrorMessage } from './error-message';
import { mobileClient, type CloudNotebook, type CloudState, type CloudSyncStatus } from '@platform/tauri/mobile-client';
import { openUrl } from '@platform/tauri/opener';

const PRIVACY_URL = 'https://flowix-memo.com/cn/privacy/';
const TERMS_URL = 'https://flowix-memo.com/cn/terms/';

interface MobileAccountPanelProps {
  state: CloudState | null;
  syncStatus: CloudSyncStatus | null;
  onClose: () => void;
  onLogout: () => void;
  onStateChange: (state: CloudState) => Promise<void>;
}

function errorMessage(error: unknown): string {
  const message = mobileErrorMessage(error);
  if (message.includes('MOBILE_CLOUD_ACCOUNT_MISMATCH')) {
    return '为防止不同云账号的笔记混用，此设备已绑定其他 Flowix Cloud 账号。当前版本暂不支持直接切换账号。';
  }
  return message;
}

function formatBytes(value: number | null | undefined): string {
  if (!value || value < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unit]}`;
}

function formatDate(value: number | null | undefined): string {
  return value ? new Date(value).toLocaleDateString() : '未设置';
}

function membershipLabel(state: CloudState | null): string {
  if (state?.membership?.active) return '订阅有效';
  if (state?.membership?.readOnly) return '已到期（只读）';
  return '未开通订阅';
}

function syncStatusLabel(status: CloudSyncStatus | null, state: CloudState | null, syncAvailable: boolean): string {
  if (!syncAvailable) {
    if (state?.membership?.readOnly) return '订阅已到期，云端内容暂时仅可查看。';
    if (!state?.membership?.active) return '开通有效订阅后，笔记会自动同步。';
    return '正在准备云同步…';
  }
  if (!status || status.state === 'idle') return '云同步已开启，等待同步。';
  if (status.state === 'success') return `最近同步完成：上传 ${status.uploaded}，下载 ${status.downloaded}`;
  if (status.state === 'error') return `同步失败：${status.lastError ? mobileErrorMessage(status.lastError) : '稍后将自动重试。'}`;
  if (status.state === 'offline') return '当前离线，网络恢复后会自动重试。';
  if (status.state === 'queued' || status.state === 'checking') return '正在检查云端更新…';
  return '正在同步笔记…';
}

function notebookSyncLabel(notebook: CloudNotebook, status: CloudSyncStatus | null, state: CloudState | null, syncAvailable: boolean): string {
  if (notebook.synced) return '已同步';
  if (!syncAvailable) return state?.membership?.readOnly ? '只读' : '未开启';
  if (status?.state === 'queued' || status?.state === 'checking' || status?.state === 'syncing' || status?.state === 'finalizing') return '同步中';
  if (status?.state === 'error') return '同步失败';
  return '待同步';
}

export function MobileAccountPanel({ state, syncStatus, onClose, onLogout, onStateChange }: MobileAccountPanelProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notebooksError, setNotebooksError] = useState('');
  const [syncError, setSyncError] = useState('');
  const [cloudNotebooks, setCloudNotebooks] = useState<CloudNotebook[]>([]);
  const [notebooksLoading, setNotebooksLoading] = useState(false);
  const touchStartRef = useRef<{ x: number; y: number; scrollTop: number } | null>(null);
  const pullOffsetRef = useRef(0);
  const closeTimerRef = useRef<number | null>(null);
  const [pullOffset, setPullOffset] = useState(0);
  const [isPulling, setIsPulling] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const authenticated = Boolean(state?.authenticated);
  const syncAvailable = cloudSyncAvailable(state);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
  }, []);

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    if (isClosing) return;
    const touch = event.touches[0];
    if (!touch) return;
    touchStartRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      scrollTop: event.currentTarget.scrollTop,
    };
    setIsPulling(false);
    pullOffsetRef.current = 0;
    setPullOffset(0);
  };

  const handleTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    const start = touchStartRef.current;
    if (!start || isClosing) return;
    const touch = event.touches[0];
    if (!touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) > Math.abs(dy)) return;
    if (dy <= 0 || start.scrollTop > 0 || event.currentTarget.scrollTop > 0) {
      if (isPulling) {
        setIsPulling(false);
        pullOffsetRef.current = 0;
        setPullOffset(0);
      }
      return;
    }
    event.preventDefault();
    setIsPulling(true);
    pullOffsetRef.current = Math.min(156, dy * 0.48);
    setPullOffset(pullOffsetRef.current);
  };

  const handleTouchEnd = () => {
    const shouldClose = pullOffsetRef.current >= 92;
    touchStartRef.current = null;
    setIsPulling(false);
    if (!shouldClose) {
      pullOffsetRef.current = 0;
      setPullOffset(0);
      return;
    }
    setIsClosing(true);
    pullOffsetRef.current = 0;
    setPullOffset(0);
    closeTimerRef.current = window.setTimeout(onClose, 180);
  };

  const loadCloudNotebooks = useCallback(async () => {
    if (!authenticated) return;
    setNotebooksLoading(true);
    try {
      setCloudNotebooks(await mobileClient.cloud.listNotebooks());
      setNotebooksError('');
    } catch (reason) {
      setNotebooksError(`无法加载云端笔记本：${errorMessage(reason)}`);
    } finally {
      setNotebooksLoading(false);
    }
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated) {
      setCloudNotebooks([]);
      setNotebooksError('');
      return;
    }
    void loadCloudNotebooks();
  }, [authenticated, loadCloudNotebooks, state?.membership?.expiresAt, state?.membership?.usedBytes]);

  useEffect(() => {
    if (!authenticated || syncStatus?.state !== 'success') return;
    setSyncError('');
    void loadCloudNotebooks();
  }, [authenticated, loadCloudNotebooks, syncStatus?.runId, syncStatus?.state]);

  const bootstrapIfAvailable = async (next: CloudState, prefix: string) => {
    await onStateChange(next);
    if (!cloudSyncAvailable(next)) return;
    try {
      setSyncError('');
      await mobileClient.bootstrapCloud();
      await onStateChange(await mobileClient.cloud.getState());
    } catch (reason) {
      setSyncError(`${prefix}，同步暂未完成：${errorMessage(reason)}`);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!email.trim() || !password) return;
    setLoading(true);
    setError('');
    setSyncError('');
    try {
      const next = await mobileClient.cloud.login(email.trim(), password);
      setPassword('');
      await bootstrapIfAvailable(next, '登录成功');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  };

  const refreshMembership = async () => {
    setLoading(true);
    setError('');
    setSyncError('');
    try {
      await mobileClient.cloud.refreshMembership();
      await bootstrapIfAvailable(await mobileClient.cloud.getState(), '订阅有效');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  };

  const resetBinding = async () => {
    const confirmed = window.confirm(
      '解除设备云账号绑定不会删除本地笔记。下次登录其他账号后，现有本地笔记会同步到该账号。是否继续？',
    );
    if (!confirmed) return;
    setLoading(true);
    setError('');
    setSyncError('');
    try {
      await mobileClient.cloud.resetBinding();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  };

  const openLegalPage = async (url: string) => {
    try {
      await openUrl(url);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  return (
    <div className="mobile-account-layer" role="presentation">
      <button type="button" className="mobile-drawer-backdrop" aria-label="关闭账号面板" onClick={onClose} />
      <section
        className="mobile-account-sheet"
        aria-label="账号与云同步"
        style={{
          transform: isClosing ? 'translateY(100%)' : pullOffset > 0 ? `translateY(${pullOffset}px)` : undefined,
          transition: isPulling ? 'none' : 'transform 180ms cubic-bezier(.2,.8,.2,1)',
        }}
      >
        <div
          className="mobile-account-sheet__scroll"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchEnd}
        >
          <header>
            <div><strong>账号与云同步</strong></div>
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
                  <LogIn size={17} />{loading ? '登录中…' : '登录'}
                </button>
              </form>
              <button type="button" className="mobile-account-reset" disabled={loading} onClick={() => void resetBinding()}>
                解除设备云账号绑定
              </button>
            </>
          ) : (
            <div className="mobile-account-content">
              <section className="mobile-account-section">
                <div className="mobile-account-info-list">
                  <div className="mobile-account-info-row">
                    <span>账号名称</span>
                    <strong>{state?.account?.user.displayName || state?.account?.user.email}</strong>
                  </div>
                  <div className="mobile-account-info-row">
                    <span>订阅状态</span>
                    <strong className={syncAvailable ? 'is-success' : undefined}>{membershipLabel(state)}</strong>
                  </div>
                  <div className="mobile-account-info-row">
                    <span>到期时间</span>
                    <strong>{formatDate(state?.membership?.expiresAt)}</strong>
                  </div>
                  <div className="mobile-account-info-row">
                    <span><HardDrive size={15} />存储使用</span>
                    <strong>{formatBytes(state?.membership?.usedBytes)} / {formatBytes(state?.membership?.quotaBytes)}</strong>
                  </div>
                </div>
                <div className="mobile-account-usage-bar" aria-hidden="true">
                  <span style={{ width: `${Math.min(100, Math.max(0, ((state?.membership?.usedBytes ?? 0) / Math.max(1, state?.membership?.quotaBytes ?? 1)) * 100))}%` }} />
                </div>
                <button type="button" className="mobile-account-logout" disabled={loading} onClick={onLogout}>
                  <LogOut size={17} />退出登录
                </button>
              </section>

              <section className="mobile-account-section mobile-account-sync-section">
                <div className="mobile-account-section-heading">
                  <h2>云端笔记本</h2>
                  <span>{cloudNotebooks.length}</span>
                </div>
                {notebooksLoading ? (
                  <p className="mobile-account-empty">正在加载笔记本…</p>
                ) : cloudNotebooks.length > 0 ? (
                  <div className="mobile-account-notebook-list">
                    {cloudNotebooks.map((notebook) => (
                      <div className="mobile-account-notebook-row" key={notebook.id}>
                        <span className="mobile-account-notebook-icon"><BookOpen size={16} /></span>
                        <strong>{notebook.name}</strong>
                        <span className="mobile-account-notebook-size">{formatBytes(notebook.usedBytes)}</span>
                        <span className={`mobile-account-notebook-status${notebook.synced ? ' is-synced' : ''}`}>
                          {notebookSyncLabel(notebook, syncStatus, state, syncAvailable)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mobile-account-empty">暂无云端笔记本</p>
                )}
                {notebooksError && <div className="mobile-account-inline-error">{notebooksError}</div>}
                {error && <div className="mobile-auth-error">{error}</div>}
                <div className="mobile-account-sync-status-label">同步状态</div>
                <p className={`mobile-sync-status${syncError || syncStatus?.state === 'error' ? ' mobile-sync-status--error' : !syncAvailable ? ' mobile-sync-status--warning' : syncStatus?.state === 'success' ? ' mobile-sync-status--success' : ''}`}>
                  {syncError || syncStatusLabel(syncStatus, state, syncAvailable)}
                </p>
                <button type="button" className="mobile-membership-refresh" disabled={loading} onClick={() => void refreshMembership()}>
                  <RefreshCw size={17} className={loading ? 'is-spinning' : undefined} />
                  {loading ? '检查中…' : '重新检查'}
                </button>
              </section>
            </div>
          )}

          <footer className="mobile-account-footer">
            <div className="mobile-account-footer__links">
              <div className="mobile-account-footer__row">
                <span>语言</span>
                <strong>简体中文</strong>
              </div>
              <button type="button" className="mobile-account-footer__row" onClick={() => void openLegalPage(PRIVACY_URL)}>
                <span>隐私协议</span>
                <strong>查看</strong>
              </button>
              <button type="button" className="mobile-account-footer__row" onClick={() => void openLegalPage(TERMS_URL)}>
                <span>服务说明</span>
                <strong>Terms</strong>
              </button>
            </div>
            <span className="mobile-account-footer__version">Flowix Memo v{packageJson.version}</span>
          </footer>
        </div>
        <button type="button" className="mobile-icon-button mobile-drawer-close-button mobile-account-close-button" aria-label="关闭账号面板" onClick={onClose}><X size={20} /></button>
      </section>
    </div>
  );
}
