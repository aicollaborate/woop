import { CloudOff, LogIn, RefreshCw, X } from 'lucide-react';
import { useState } from 'react';

import { cloudSyncAvailable } from './mobile-model';
import { mobileClient, type CloudState, type CloudSyncStatus } from '@platform/tauri/mobile-client';

interface MobileAccountPanelProps {
  state: CloudState | null;
  syncStatus: CloudSyncStatus | null;
  onClose: () => void;
  onStateChange: (state: CloudState) => Promise<void>;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('MOBILE_CLOUD_ACCOUNT_MISMATCH')) {
    return '为防止不同云账号的笔记混用，此设备已绑定其他 Flowix Cloud 账号。当前版本暂不支持直接切换账号。';
  }
  return message;
}

export function MobileAccountPanel({ state, syncStatus, onClose, onStateChange }: MobileAccountPanelProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const authenticated = Boolean(state?.authenticated);
  const syncAvailable = cloudSyncAvailable(state);

  const bootstrapIfAvailable = async (next: CloudState, prefix: string) => {
    await onStateChange(next);
    if (!cloudSyncAvailable(next)) return;
    try {
      await mobileClient.bootstrapCloud();
      await onStateChange(await mobileClient.cloud.getState());
    } catch (reason) {
      setError(`${prefix}，但同步失败：${errorMessage(reason)}`);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!email.trim() || !password) return;
    setLoading(true);
    setError('');
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
    try {
      await mobileClient.cloud.resetBinding();
    } catch (reason) {
      setError(errorMessage(reason));
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
            <button type="button" className="mobile-account-reset" disabled={loading} onClick={() => void resetBinding()}>
              解除设备云账号绑定
            </button>
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
            {syncStatus && (
              <p className={`mobile-sync-status mobile-sync-status--${syncStatus.state}`}>
                {syncStatus.state === 'error'
                  ? `同步未完成：${syncStatus.lastError || '将在网络恢复后重试'}`
                  : syncStatus.state === 'success'
                    ? `最近同步完成：上传 ${syncStatus.uploaded}，下载 ${syncStatus.downloaded}`
                    : '正在同步笔记…'}
              </p>
            )}
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
