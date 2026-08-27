import type { I18nKey, I18nParams } from '@/lib/i18n';

/**
 * 相对时间格式化 —— memo 列表卡片与 Agent 对话列表共用同一套口径。
 *
 * 阈值分级: 刚刚 → 秒 → 分 → 时 → 天 → 月, 超过 30 天按月计。所有文案走
 * i18n (memo.time.*), 跨语言一致, 不依赖 Intl 的 locale 分隔符差异。
 */
export function formatTimeAgo(
  timestamp: number,
  t: (key: I18nKey, params?: I18nParams) => string,
  options?: { compact?: boolean },
): string {
  const compact = options?.compact ?? false;
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 30) {
    const months = Math.floor(days / 30);
    return t(compact ? 'agent.time.months' : 'memo.time.monthsAgo', { m: months } satisfies I18nParams);
  }
  if (days > 0) return t(compact ? 'agent.time.days' : 'memo.time.daysAgo', { d: days } satisfies I18nParams);
  if (hours > 0) return t(compact ? 'agent.time.hours' : 'memo.time.hoursAgo', { h: hours } satisfies I18nParams);
  if (minutes > 0) return t(compact ? 'agent.time.minutes' : 'memo.time.minutesAgo', { m: minutes } satisfies I18nParams);
  if (seconds > 0) return t(compact ? 'agent.time.seconds' : 'memo.time.secondsAgo', { s: seconds } satisfies I18nParams);
  return t(compact ? 'agent.time.justNow' : 'memo.time.justNow');
}
