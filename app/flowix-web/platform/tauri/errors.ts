import type { I18nKey } from '@/lib/i18n';

/**
 * Tauri IPC 错误格式化。
 *
 * 不直接读 user-settings-store / 不内嵌 translate ── 那会让 platform 层反向依赖
 * features。改为接受调用方传入的 `t` (通常来自 useI18n), 由 features 层负责翻译。
 * platform 层只做错误码识别 + 文案键映射。
 */

export function tauriErrorMessage(error: unknown): string {
  return String(error ?? '');
}

export function hasTauriErrorCode(error: unknown, code: string): boolean {
  return tauriErrorMessage(error).includes(code);
}

type Translate = (key: I18nKey) => string;

export function notebookCreateErrorMessage(error: unknown, t: Translate): string {
  if (hasTauriErrorCode(error, 'PATH_ALREADY_REGISTERED')) return t('preferences.error.pathAlreadyRegistered');
  if (hasTauriErrorCode(error, 'PATH_MISSING')) return t('preferences.error.pathMissing');
  if (hasTauriErrorCode(error, 'INVALID_NAME')) return t('preferences.error.invalidName');
  if (hasTauriErrorCode(error, 'INVALID_PATH')) return t('preferences.error.invalidPath');
  if (hasTauriErrorCode(error, 'INDEX_WRITE_FAILED')) return t('preferences.error.indexWriteFailedCreate');
  return t('preferences.error.createFailed');
}

export function notebookDeleteErrorMessage(error: unknown, t: Translate): string {
  if (hasTauriErrorCode(error, 'NOTEBOOK_NOT_FOUND')) return t('preferences.error.notebookNotFound');
  if (hasTauriErrorCode(error, 'INDEX_WRITE_FAILED')) return t('preferences.error.indexWriteFailedDelete');
  return t('preferences.error.deleteFailed');
}
