/** 主题桶 - 纯核心 re-export 自 @/lib/theme; React 绑定 (ThemeProvider) 本地提供。 */
export type { ThemeId, ResolvedThemeId } from '@/lib/theme';
export {
  THEME_IDS,
  DEFAULT_THEME_ID,
  sanitizeTheme,
  resolveSystemTheme,
  applyTheme,
  type ApplyOptions,
  THEME_OPTIONS,
  type ThemeOption,
} from '@/lib/theme';
export { ThemeProvider } from '@features/theme/provider';
