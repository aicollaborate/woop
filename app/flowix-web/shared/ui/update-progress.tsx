'use client';

import { cn } from '@/lib/utils';

export interface UpdateProgressValue {
  percent?: number | null;
  downloadedBytes?: number;
  totalBytes?: number | null;
  resumed?: boolean;
}

interface UpdateProgressProps {
  value: UpdateProgressValue;
  label: string;
  resumedLabel?: string;
  className?: string;
}

/** Shared progress presentation for app and runtime updates. */
export function UpdateProgress({ value, label, resumedLabel, className }: UpdateProgressProps) {
  const percent = value.percent == null ? null : Math.min(100, Math.max(0, Math.round(value.percent)));

  return (
    <div className={cn('space-y-2', className)} aria-live="polite">
      <div className="flex justify-between gap-3 text-xs text-[var(--muted-foreground)]">
        <span>{label}</span>
        <span>{percent == null ? '…' : `${percent}%`}</span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-[var(--muted)]"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <div
          className={cn(
            'h-full rounded-full bg-[var(--primary)] transition-[width]',
            percent == null && 'w-1/3 animate-pulse',
          )}
          style={percent == null ? undefined : { width: `${percent}%` }}
        />
      </div>
      {value.resumed && resumedLabel && (
        <p className="text-xs text-[var(--muted-foreground)]">{resumedLabel}</p>
      )}
    </div>
  );
}
