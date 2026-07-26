/**
 * Tauri core IPC 原语 (invoke / convertFileSrc) 的 platform 封装。
 *
 * features 通过此模块发起 IPC 或转换 asset URL, 不直接 import @tauri-apps/api/core。
 * 既有结构化 RPC 封装在 @platform/tauri/client; 本模块暴露底层原语供少量未结构化的
 * 调用点 (attachment 上传 / 图片 asset URL) 使用。
 */
export { invoke, convertFileSrc } from '@tauri-apps/api/core';
