'use client';

import { useCallback, useEffect, useState } from 'react';
import { Cloud, RefreshCw } from 'lucide-react';

import appleLogo from '@/assets/apple.svg';
import { errorMessage } from '@/lib/error-message';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/lib/toast';
import { openUrl } from '@platform/tauri/opener';
import { cloudSyncErrorMessage } from '@platform/tauri/errors';
import {
  cloud,
  listenToCloudStateChanges,
  type CloudProduct,
  type CloudState,
} from '@platform/tauri/client';
import { Button } from '@shared/ui/button';
import { Input } from '@shared/ui/input';
import { SectionHeader } from '@features/preferences/sections/primitives';
import { cn } from '@/lib/utils';
import { isMac } from '@/lib/shortcuts/platform';

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function Toggle({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-[var(--primary)]' : 'bg-[var(--muted)]',
      )}
    >
      <span
        className={cn(
          'absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
          checked ? 'translate-x-5' : 'translate-x-0',
        )}
      />
    </button>
  );
}

export function CloudSyncSection() {
  const { t } = useI18n();
  const [state, setState] = useState<CloudState | null>(null);
  const [products, setProducts] = useState<CloudProduct[]>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [legacyLoginOpen, setLegacyLoginOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [nextState, nextProducts] = await Promise.all([
        cloud.getState(),
        cloud.listProducts(),
      ]);
      setState(nextState);
      setProducts(nextProducts);
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void load();
    const unlisten = listenToCloudStateChanges(setState);
    const onFocus = () => {
      if (!state?.authenticated) return;
      void cloud.refreshMembership()
        .then((membership) => setState((current) => current
          ? { ...current, membership }
          : current))
        .catch(() => undefined);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      unlisten();
      window.removeEventListener('focus', onFocus);
    };
  }, [load, state?.authenticated]);

  const run = async (task: () => Promise<CloudState>) => {
    setBusy(true);
    try {
      const next = await task();
      setState(next);
      setPassword('');
    } catch (error) {
      toast.error(cloudSyncErrorMessage(error, t));
    } finally {
      setBusy(false);
    }
  };

  const submitLegacyLogin = () => {
    if (!email.trim() || !password) return;
    void run(() => cloud.login(email.trim(), password));
  };

  if (!state) {
    return (
      <div className="space-y-4">
        <SectionHeader title={t('preferences.cloud.title')} />
        {loadError ? (
          <p className="break-words text-sm text-[var(--destructive)]">
            {loadError}
          </p>
        ) : (
          <p className="text-sm text-[var(--muted-foreground)]">
            {t('preferences.cloud.loading')}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-8">
      <SectionHeader title={t('preferences.cloud.title')} />
      <p className="text-sm text-[var(--muted-foreground)]">
        {t('preferences.cloud.description')}
      </p>

      {!state.authenticated ? (
        <div className="space-y-4 rounded-xl border border-[var(--border)] p-4">
          {isMac() ? (
            <Button
              className="w-full gap-2 rounded-2xl bg-black text-white hover:bg-black/85"
              disabled={busy}
              onClick={() => void run(() => cloud.signInWithApple())}
            >
              <img
                src={appleLogo}
                alt=""
                aria-hidden="true"
                className="h-4 w-4 object-contain"
              />
              {busy
                ? t('preferences.cloud.working')
                : t('preferences.cloud.appleSignIn')}
            </Button>
          ) : (
            <p className="rounded-lg bg-[var(--muted)] px-3 py-2 text-xs text-[var(--muted-foreground)]">
              {t('preferences.cloud.registrationMacOnly')}
            </p>
          )}
          <button
            type="button"
            aria-expanded={legacyLoginOpen}
            aria-controls="cloud-email-login"
            onClick={() => setLegacyLoginOpen((open) => !open)}
            className="mx-auto block text-center text-xs text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
          >
            {t('preferences.cloud.existingAccount')}
          </button>
          {legacyLoginOpen && (
            <div id="cloud-email-login" className="space-y-3">
              <Input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder={t('preferences.cloud.email')}
              />
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') submitLegacyLogin();
                }}
                placeholder={t('preferences.cloud.password')}
              />
              <Button
                className="w-full"
                disabled={busy || !email.trim() || !password}
                onClick={submitLegacyLogin}
              >
                {busy
                  ? t('preferences.cloud.working')
                  : t('preferences.cloud.login')}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-[var(--border)] p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--muted)]">
                <Cloud className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {state.account?.user.displayName}
                </div>
                <div className="truncate text-xs text-[var(--muted-foreground)]">
                  {state.account?.user.email}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {isMac() && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-xl"
                    disabled={busy}
                    onClick={() => void run(() => cloud.linkApple())}
                  >
                    <img
                      src={appleLogo}
                      alt=""
                      aria-hidden="true"
                      className="h-3.5 w-3.5 object-contain"
                    />
                    {t('preferences.cloud.linkApple')}
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-xl"
                  disabled={busy}
                  onClick={() => void run(() => cloud.logout())}
                >
                  {t('preferences.cloud.logout')}
                </Button>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--border)] p-4">
            <div>
              <div className="text-sm font-medium">{t('preferences.cloud.masterSwitch')}</div>
              <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                {t('preferences.cloud.masterSwitchDescription')}
              </div>
            </div>
            <Toggle
              checked={state.enabled}
              disabled={busy}
              label={t('preferences.cloud.masterSwitch')}
              onChange={(enabled) => void run(() => cloud.setEnabled(enabled))}
            />
          </div>

          <div className="space-y-3 rounded-xl border border-[var(--border)] p-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">{t('preferences.cloud.membership')}</div>
              <span className={cn(
                'rounded-full px-2 py-0.5 text-xs',
                state.membership?.active
                  ? 'bg-emerald-500/15 text-emerald-600'
                  : 'bg-amber-500/15 text-amber-600',
              )}>
                {state.membership?.active
                  ? t('preferences.cloud.active')
                  : t('preferences.cloud.inactive')}
              </span>
            </div>
            <div className="text-sm text-[var(--muted-foreground)]">
              {t('preferences.cloud.usage')}: {formatBytes(state.membership?.usedBytes ?? 0)}
              {' / '}
              {formatBytes(state.membership?.quotaBytes ?? 0)}
            </div>
            {state.membership?.expiresAt && (
              <div className="text-xs text-[var(--muted-foreground)]">
                {t('preferences.cloud.expires')}:{' '}
                {new Date(state.membership.expiresAt).toLocaleDateString()}
              </div>
            )}
            <Button
              variant="outline"
              className="w-full gap-2"
              disabled={busy || !state.enabled}
              onClick={() => {
                setBusy(true);
                void cloud.syncNow()
                  .then((result) => {
                    toast.success(
                      `${t('preferences.cloud.syncComplete')}: ↑${result.uploaded} ↓${result.downloaded}`,
                    );
                  })
                  .catch((error) => toast.error(cloudSyncErrorMessage(error, t)))
                  .finally(() => setBusy(false));
              }}
            >
              <RefreshCw className={cn('h-4 w-4', busy && 'animate-spin')} />
              {t('preferences.cloud.syncNow')}
            </Button>
          </div>

          <div className="space-y-3">
            <div className="text-sm font-medium">{t('preferences.cloud.plans')}</div>
            {products.map((product) => (
              <div
                key={product.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] p-4"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium">{product.name}</div>
                  <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                    {product.description}
                  </div>
                  <div className="mt-1 text-sm">
                    {(product.price.amount / 100).toFixed(2)} {product.price.currency.toUpperCase()}
                  </div>
                </div>
                <Button
                  size="sm"
                  className="rounded-xl"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void cloud.createCheckout(product.id)
                      .then((checkout) => openUrl(checkout.checkoutUrl))
                      .catch((error) => toast.error(errorMessage(error)))
                      .finally(() => setBusy(false));
                  }}
                >
                  {t('preferences.cloud.buy')}
                </Button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
