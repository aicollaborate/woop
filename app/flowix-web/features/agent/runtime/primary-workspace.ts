/**
 * 主工作目录 (cwd) 单一 cascade ── 提交时 runtime cwd 与 UI 一致。
 *
 * 首次运行时，agent 的文件区域由「所属笔记本的资料列表 + 笔记本路径」
 * 决定；结果随后写入 instance.workspaceSnapshot，后续运行不再调用本函数:
 *
 *   1. defaultFiles.workspace   ─ 侧边栏资料列表里显式设的主空间 folder
 *   2. (skip) defaultFiles.workspace === null → 跳过 folders[0], 直接退到
 *      notebookPath: 用户**显式取消主空间** (右键菜单"取消主空间"),
 *      folders 里所有 folder 都不是主空间, 当前笔记本自动 fallback 为主空间。
 *   3. defaultFiles.workspace 未设置 (legacy undefined) + folders[0] ─
 *      老数据没有 workspace 字段, 沿用 folders[0] 兜底以兼容历史 instance。
 *   4. notebookPath             ─ 没 folders 时, 主空间 = 当前笔记本路径
 *   5. empty
 *
 * 「资料列表」= `agent-access.defaults.files[<notebookId>]`, 由侧边栏
 * `NotebookAccessFilesList` 编辑 (添加 folder / 切主空间 / 取消主空间 /
 * 删除 folder)。`notebookPath` = instance.notebookId 对应的笔记本路径。
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

  // 1b. 资料主空间被显式置 null (用户右键"取消主空间") ── 跳过
  // folders[0] 兜底, 直接退到 notebookPath, 与 UI `effectiveWorkspace`
  // (`workspace && folderPaths.includes(workspace) ? workspace : notebook.path`)
  // 行为一致。folders 里的 folder 不再被隐式升级为主空间。
  if (input.defaultFiles?.workspace === null) {
    const notebookPath = normalize(input.notebookPath);
    if (notebookPath) {
      return { kind: "notebook", path: notebookPath };
    }
    return { kind: "empty" };
  }

  // 2. 资料列表第一个 folder ── 老数据 (workspace 未设置 = undefined)
  // 兼容路径: 保留 folders[0] 兜底以避免老 instance 突然失去 cwd。
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
