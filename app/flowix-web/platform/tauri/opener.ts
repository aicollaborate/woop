/**
 * 外部链接 / 文件打开 (openUrl / openPath) 的 platform 封装。
 *
 * features 通过此模块打开外部 URL 或系统文件, 不直接 import @tauri-apps/plugin-opener。
 * 与 platform/open-target (打开笔记) 区分: 本模块打开的是浏览器/系统层面的目标。
 */
export { openUrl, openPath } from '@tauri-apps/plugin-opener';
