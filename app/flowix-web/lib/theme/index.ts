/**
 * 主题系统纯核心 (types / palette / sanitize / apply / options) - 单一真源。
 *
 * 纯逻辑下沉到此层, 供 lib / platform / shared 直接引用 (不反向依赖 features)。
 * React 绑定 (ThemeProvider, 订阅 user-settings-store) 留在 features/theme。
 */
export type { ThemeId, ResolvedThemeId } from './types';
export { THEME_IDS, DEFAULT_THEME_ID } from './palette';
export { sanitizeTheme, resolveSystemTheme } from './sanitize';
export { applyTheme, type ApplyOptions } from './apply';
export { THEME_OPTIONS, type ThemeOption } from './options';
