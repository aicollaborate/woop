/**
 * Agent 访问目录 (可访问文件夹) — 镜像后端 `app/flowix-desktop/src/agent_access.rs`
 * 的 `AgentAccessConfig` / `AgentAccessEntry` / `AgentAccessKind`。
 *
 * 真源在 `~/.flowix/agent-access.json` (后端 `agent_access::AgentAccessStore`),
 * 前端走 `lib/tauri/client.ts::agentAccess` IPC 读写。 整份 set 走乐观更新,
 * 跨窗口同步靠后端 emit 的 `agent-access-changed` 事件。
 */

import type {
  AgentCodexReasoningEffort,
  AgentPermissionMode,
  AgentTypeKey,
  FilesConfig,
} from "@/types/agent";

/**
 * Responsibility split for `~/.flowix/agent-access.json`:
 *
 * - `defaults`: default runtime/files values copied into a newly created
 *   agent-thread-card instance.
 * - `entries`: legacy/global access registry and default candidates used by
 *   old instances or instances without `runtimeConfig.files`.
 * - actual per-run file permission: instance `runtimeConfig.files`, sent as
 *   IPC `runtimeConfig.{agent}.workspacePaths`.
 */

export type AgentAccessKind = "notebook" | "folder";

export interface AgentAccessEntry {
  id: string;
  kind: AgentAccessKind;
  path: string;
  name: string;
  enabled: boolean;
  workspace?: boolean;
  addedAt: number;
  updatedAt: number;
  /** 运行时由后端重算: 该 path 在磁盘上是否还存在。 失联目录保留在列表,
   *  UI 据此灰显 + 强制禁用勾选框。 */
  missing: boolean;
}

export interface AgentAccessDefaultRuntime {
  model?: { key: string };
  access?: { sandbox: AgentPermissionMode };
  reasoningEffort?: AgentCodexReasoningEffort;
}

/**
 * `defaults.files` 的全局兜底 key ── 老版本单对象 `defaults.files` 迁移落点,
 * 以及创建时未选笔记本 / 历史 instance (无 `runtimeConfig.notebookId`) 回写
 * 时的 fallback 目标。
 */
export const DEFAULT_FILES_GLOBAL_KEY = "_global";

/**
 * 按 notebook 维度索引的 files 默认 ── key 为 notebook.id,
 * `DEFAULT_FILES_GLOBAL_KEY` ("_global") 为兜底。 同一 notebook 下新建的
 * agent 卡片共享该 notebook 的默认文件列表; 不同 notebook 互不影响。
 *
 * 老版本 `defaults.files` 是单个 `FilesConfig` 对象, 读取时由
 * `normalizeFilesDefaults` 归一化到 `{ _global: <old> }`, 写入时始终落索引。
 */
export type AgentAccessFilesDefaults = Record<string, FilesConfig>;

export interface AgentAccessDefaults {
  runtime?: Partial<Record<AgentTypeKey, AgentAccessDefaultRuntime>>;
  files?: AgentAccessFilesDefaults;
}

export interface AgentAccessConfig {
  version: number; // 当前 = 1
  entries: AgentAccessEntry[];
  defaults?: AgentAccessDefaults;
}
