export {
  APP_LANGUAGES,
  DEFAULT_APP_LANGUAGE,
  LANGUAGE_OPTIONS,
  getMessages,
  isLanguageLoaded,
  loadLanguage,
  sanitizeAppLanguage,
  type AppLanguage,
  type I18nKey,
  type MessageMap,
} from '@/lib/i18n/locales';
export { I18nProvider, translate, useI18n, type I18nParams } from '@/lib/i18n/provider';
export { detectSystemLanguage } from '@/lib/i18n/detect';
export {
  useRegionStore,
  getCurrentRegion,
  isMainlandChina,
  sanitizeRegion,
  detectRegion,
  type Region,
} from '@/lib/i18n/region-store';
