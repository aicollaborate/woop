/**
 * "通过链接打开笔记" - platform 层只保留纯解析原语 (types / path-helper / 事件常量)。
 *
 * 编排逻辑 (openNoteByTarget / openNoteByDeepLink / openNoteByPhysicalPath /
 * openNoteByMemoId / mountOpenTargetListener) 已上移到 features/memo/use-cases ──
 * 它们操纵 memo/document store, 属应用编排, 不该在 platform 层反向依赖 features。
 *   - features/memo/use-cases/open-by-target.ts      主动打开 + 轻量解析
 *   - features/memo/use-cases/open-target-listener.ts 跨窗口事件订阅
 *
 * 本模块剩余 (后端 open_target 契约 + 纯路径解析):
 *   - ResolvedOpenTarget 类型 + FLOWIX_OPEN_TARGET_EVENT 事件常量
 *   - path-helper (resolveAbsolutePath)
 */

export type { ResolvedOpenTarget } from '@platform/open-target/types';
export { FLOWIX_OPEN_TARGET_EVENT } from '@platform/open-target/types';
export { resolveAbsolutePath } from '@platform/open-target/path-helper';
