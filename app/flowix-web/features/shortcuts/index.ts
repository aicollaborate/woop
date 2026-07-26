/**
 * 快捷键系统 - 公开 API 桶。
 *
 * 纯核心 (types / parser / platform / matcher / registry / handler-registry /
 * shortcuts-provider / use-shortcut-scope) 已下沉到 @/lib/shortcuts, 供 lib/shared
 * 直接引用而不反向依赖 features。 本桶 re-export 之, 保持既有 @features/shortcuts
 * 调用方不变。
 *
 * feature 耦合的 action 定义在 ./actions (调用 document/theme/preferences store),
 * 由 app.tsx 顶层 `import "@features/shortcuts/actions"` 副作用挂载。
 */
export * from '@/lib/shortcuts';
