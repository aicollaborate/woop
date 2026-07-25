/**
 * 主工作目录 (cwd) 单一 cascade ── 提交时 runtime cwd 与 UI 一致。
 *
 * 首次运行时，agent 的文件区域由「所属笔记本的资料列表 + 笔记本路径」
 * 决定；结果随后写入 instance.workspaceSnapshot，后续运行不再调用本函数:
 *
 *   1. defaultFiles.workspace   ─ 侧边栏资料列表里显式设的主空间 folder
 *   2. defaultFiles.folders[0]  ─ 有资料但没显式设主空间时, 取第一个
 *   3. notebookPath             ─ 没有资料时, 主空间 = 当前笔记本路径
 *   4. empty
 *
 * 「资料列表」= `agent-access.defaults.files[<notebookId>]`, 由侧边栏
 * `NotebookAccessFilesList` 编辑 (添加 folder / 切主空间 / 删除 folder)。
 * `notebookPath` = instance.notebookId 对应的笔记本路径。
 */
import type { FilesConfig } from "@/types/agent";
import { normalizeWorkspacePath } from "@features/agent/runtime/workspace-path";

export type PrimaryWorkspaceSource =
  | { kind: "default.workspace"; path: string }
  | { kind: "default.folders[0]"; path: string }
  | { kind: "notebook"; path: string }
  | { kind: "empty" };

export interface ResolvePrimaryWorkspaceInput {
  /** 当前笔记本的资料默认 (defaults.files[<notebookId>])。 */
  defaultFiles?: FilesConfig;
  /** 当前选中笔记本路径 ── 无资料时的主空间。 */
  notebookPath?: string;
}

/**
 * 严格按字面顺序短路: 第一段命中即返回, 最后落到 `empty`。
 */
export function resolvePrimaryWorkspace(
  input: ResolvePrimaryWorkspaceInput,
): PrimaryWorkspaceSource {
  const normalize = (path: string | null | undefined): string | undefined =>
    normalizeWorkspacePath(path) || undefined;

  // 1. 资料主空间 ── 侧边栏资料列表里显式设的主空间 folder。
  const defaultWorkspace = normalize(input.defaultFiles?.workspace);
  if (defaultWorkspace) {
    return { kind: "default.workspace", path: defaultWorkspace };
  }

  // 2. 资料列表第一个 folder ── 有资料但没显式设主空间时, 用第一个。
  const folders = input.defaultFiles?.folders ?? [];
  for (const raw of folders) {
    const first = normalize(raw);
    if (first) return { kind: "default.folders[0]", path: first };
  }

  // 3. 当前笔记本路径 ── 没有资料时, 主空间 = 当前笔记本。
  const notebookPath = normalize(input.notebookPath);
  if (notebookPath) {
    return { kind: "notebook", path: notebookPath };
  }

  // 4. empty
  return { kind: "empty" };
}
