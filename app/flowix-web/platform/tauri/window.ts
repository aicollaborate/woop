/**
 * Tauri window API 的 platform 封装。
 *
 * features/shared/lib 通过此模块访问 window API, 不直接 import @tauri-apps/* ──
 * 让 platform 层成为 Tauri 适配的唯一边界 (便于 lint 边界规则 + 未来换实现)。
 */
export { getCurrentWindow } from '@tauri-apps/api/window';
