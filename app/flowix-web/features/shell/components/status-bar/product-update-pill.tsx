'use client';

import { ArrowDownToLine, ArrowUp } from 'lucide-react';
import type { AppUpdaterState } from '@features/shell/hooks/use-app-updater';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';

/** Compact signed-app-update CTA for the desktop status bar. */
export function ProductUpdatePill({ updater }: { updater: AppUpdaterState }) {
  const { t } = useI18n();
  const { status, update, installNow } = updater;

  async function handleClick() {
    if (!update || status === 'installing') return;
    try {
      await installNow();
    } catch {
      toast.error(t('appUpdates.installFailed'));
    }
  }

  if (!update || status === 'error' || status === 'none' || status === 'idle' || status === 'checking') {
    return null;
  }

  const installing = status === 'installing';
  const label = installing ? t('appUpdates.installing') : t('appUpdates.install');

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={installing}
      title={`${t('appUpdates.available')}: ${update.version}`}
      className={cn(
        'inline-flex h-[22px] items-center gap-0.5 rounded-md px-2',
        'bg-[var(--info)] text-[var(--info-foreground)]',
        'hover:opacity-90 active:opacity-80',
        'disabled:cursor-wait disabled:opacity-80',
        'text-xs leading-none font-medium',
      )}
      aria-label={label}
    >
      {installing ? (
        <ArrowDownToLine className="h-3 w-3 shrink-0 animate-bounce" />
      ) : (
        <ArrowUp className="h-3 w-3 shrink-0" />
      )}
      <span>{label}</span>
    </button>
  );
}
