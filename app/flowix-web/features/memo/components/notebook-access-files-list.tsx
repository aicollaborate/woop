'use client';

import { useCallback } from 'react';
import { Folder } from '@phosphor-icons/react';
import { Plus, Star } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useAgentAccessStore } from '@features/agent/store/agent-access-store';
import { normalizeFilesDefaults } from '@/lib/agent-access-defaults';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Tooltip } from '@shared/ui/tooltip';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@shared/ui/context-menu';
import { NotebookIcon, useMemoStore, type Notebook } from '@features/memo';

/**
 * 选中笔记本的"可访问文件夹"展示 ── 渲染该 notebook 下 agent 的默认
 * folders (`agent-access.defaults.files[<notebookId>].folders`, 仅取该 notebook
 * 自己的默认, 不 fallback 全局兜底), 视觉参考 agent thread card 的 access
 * popover: 复用 `agent-thread-card__access-*` 全局 CSS, 主空间行在 avatar 左上角
 * 叠三角角标。
 *
 * 空状态: 仍展示"资料"分类文案 + 「添加资料」按钮 ── 点击走全局 picker 加
 * folder, 并把它写进该 notebook 自己的默认 (空时首个 folder 兼任主空间),
 * 让资料区立即出现该 folder。 有内容时只展示 folder 行 (主空间 / 删除入口
 * 走右键菜单)。
 *
 * path 不在全局 entries (用户删了 folder 但默认仍存) 时按 missing 灰显,
 * name 取路径末段兜底。 与标签列表同处一个滚动容器 (资料在上, 标签在下)。
 *
 * ## 主空间语义 ── 与 `primary-workspace.ts::resolvePrimaryWorkspace` 对齐
 *
 * - `defaultFiles.workspace === string` (string 在合法 folders 内) ── 显式主空间, 该行显示角标。
 * - `defaultFiles.workspace === null` ── 用户**显式取消主空间** (右键菜单
 *   "取消主空间"), folders 里所有 folder 都不是主空间, 当前 notebook
 *   自动 fallback 为主空间 (`effectiveWorkspace = notebook.path`)。
 * - `defaultFiles.workspace === undefined` ── 老数据未设置, 沿用 folders[0]
 *   兜底以兼容历史 instance (与 runtime cascade 行为对齐)。
 *
 * ## 右键菜单 ── 参考 `tag-tree.tsx` 的 `ContextMenu` 用法
 *
 * - 设为主空间 / 取消主空间: 二选一, 根据 `isWorkspace` 分支。
 *   `canSetWorkspace = folderItems.length > 1 && !item.missing` ── 单 folder
 *   或 missing 路径不提供"设为主空间"(无切换对象 / missing 不能当主空间);
 *   但**单 folder 也支持"取消主空间"** (决策 4) ── 取消后 effectiveWorkspace
 *   落到 notebook.path, 行角标消失, 视觉与多 folder 一致。
 * - 删除: 直接触发 `setDefaultFiles` 写盘 + `toast.success` 提示; 用户无需
 *   二次确认 (单 folder 删除, 走 toast 即足够; 若需撤销, 后续可接 toast.action)。
 *   原 hover Trash 按钮已移除 (决策 2), 删除入口仅在右键菜单。
 *
 * 行 onClick = 在中间列打开该文件夹的 VSCode 风格文件树 (浏览资料),
 * 主空间切换完全由右键菜单承担; missing 行不挂交互, 仅展示。
 */
interface NotebookAccessFilesListProps {
  notebook: Notebook | undefined;
}

interface ResolvedItem {
  path: string;
  name: string;
  missing: boolean;
}

// Agent-access paths can come from older config files or different platform
// path spellings. Use the same comparison semantics as the access-defaults
// resolver so the visual badge follows the persisted workspace value.
const comparablePath = (path: string): string =>
  path.trim().replace(/[\\/]+$/, '').toLowerCase();

export function NotebookAccessFilesList({
  notebook,
}: NotebookAccessFilesListProps) {
  const { t } = useI18n();
  const notebookId = notebook?.id;
  const config = useAgentAccessStore((s) => s.config);
  const addFolderFromPicker = useAgentAccessStore((s) => s.addFolderFromPicker);
  const setDefaultFiles = useAgentAccessStore((s) => s.setDefaultFiles);
  const setActiveFileBrowserPath = useMemoStore((s) => s.setActiveFileBrowserPath);
  const activeFileBrowserPath = useMemoStore((s) => s.activeFileBrowserPath);

  // 只展示该 notebook 自己的默认 folders, 不 fallback 全局兜底 ── 全局默认
  // 与本笔记本无关, 展示会造成混淆。 未在本笔记本的卡片里勾选过 (无
  // defaults.files[<notebookId>]) 时进入空状态。
  const defaultFiles = notebookId
    ? normalizeFilesDefaults(config?.defaults?.files)[notebookId]
    : undefined;
  const folderPaths = defaultFiles?.folders ?? [];
  const workspace = defaultFiles?.workspace;
  const entries = config.entries;
  const resolveItem = (path: string): ResolvedItem => {
    const found = entries.find(
      (e) => e.kind === 'folder' && comparablePath(e.path) === comparablePath(path),
    );
    if (found) return { path, name: found.name, missing: found.missing };
    // 默认里存了 path 但全局 entries 已没有 (folder 被删): 按缺失处理,
    // name 用路径末段兜底, 让用户仍能认出是哪个目录。
    const trimmed = path.replace(/[\\/]+$/, '');
    const derived = trimmed.split(/[\\/]/).pop() || trimmed;
    return { path, name: derived, missing: true };
  };

  const folderItems = folderPaths.map(resolveItem);

  // Keep the actual folder path for the badge/delete logic. Comparing the raw
  // strings made the star disappear when one side had a trailing slash (or
  // different casing), even though it referred to the selected folder.
  const explicitWorkspacePath =
    typeof workspace === 'string'
      ? folderItems.find(
          (item) =>
            !item.missing && comparablePath(item.path) === comparablePath(workspace),
        )?.path
      : undefined;
  const legacyWorkspacePath =
    workspace === undefined
      ? folderItems.find((item) => !item.missing)?.path
      : undefined;
  const primaryFolderPath = explicitWorkspacePath ?? legacyWorkspacePath;

  const handleAddFolder = useCallback(async () => {
    const result = await addFolderFromPicker();
    if (!result.ok) {
      if (result.code === 'already-tracked') {
        toast.error(t('agent.access.alreadyTracked'));
      } else if (result.code === 'save-failed') {
        toast.error(t('agent.access.saveFailed'));
      }
      return;
    }
    // 加进该 notebook 自己的默认, 让文件区立即出现该 folder。 空状态下首个
    // folder 兼任主空间 (workspace), 与卡片里"添加并选中"语义一致。 无选中
    // notebook 时只加全局 entries, 不写默认。
    if (!notebookId) return;
    // The picker reloads the global config before returning. Resolve the
    // latest notebook defaults instead of appending to a stale render closure.
    const latestConfig = useAgentAccessStore.getState().config;
    const latestFiles = normalizeFilesDefaults(latestConfig.defaults?.files)[notebookId];
    if (
      (latestFiles?.folders ?? []).some(
        (path) => comparablePath(path) === comparablePath(result.entry.path),
      )
    ) {
      toast.info(t('agent.access.folderExists'));
      return;
    }
    const nextFolders = Array.from(new Set([...(latestFiles?.folders ?? []), result.entry.path]));
    const latestWorkspace = latestFiles?.workspace;
    const saved = await setDefaultFiles(notebookId, {
      workspace:
        latestWorkspace && nextFolders.includes(latestWorkspace)
          ? latestWorkspace
          : nextFolders[0],
      folders: nextFolders,
      notebooks: latestFiles?.notebooks ?? [],
    });
    if (!saved) toast.error(t('agent.access.saveFailed'));
  }, [addFolderFromPicker, setDefaultFiles, notebookId, t]);

  // 切换主空间 ── 仅在「多个资料文件夹」时提供入口 (单 folder 无切换对象);
  // missing 路径不能当主空间; 写入 `workspace = path`。 与本列表只读该
  // notebook 的默认一致, 不碰全局 entries 的 workspace 标志 (那是 agent
  // thread card access popover 的职责)。
  const handleSetWorkspace = useCallback(
    async (path: string) => {
      if (!notebookId) return;
      const saved = await setDefaultFiles(notebookId, {
        workspace: path,
        folders: folderPaths,
        notebooks: defaultFiles?.notebooks ?? [],
      });
      if (!saved) toast.error(t('agent.access.saveFailed'));
    },
    [notebookId, folderPaths, defaultFiles, setDefaultFiles, t],
  );

  // 取消主空间 ── 显式置 `workspace = null`, 让 runtime 与 UI 一致 fallback
  // 到 notebook.path (primary-workspace.ts::resolvePrimaryWorkspace 1b 分支)。
  // 单 folder 场景下也允许触发: 取消后该行不再显示角标, 当前笔记本自动成为
  // 主空间 (决策 4)。folders 列表本身不变 (folder 仍在资料区)。
  const handleUnsetWorkspace = useCallback(async () => {
    if (!notebookId) return;
    const saved = await setDefaultFiles(notebookId, {
      workspace: null,
      folders: folderPaths,
      notebooks: defaultFiles?.notebooks ?? [],
    });
    if (!saved) toast.error(t('agent.access.saveFailed'));
  }, [notebookId, folderPaths, defaultFiles, setDefaultFiles, t]);

  // 删除资料文件夹 ── 只删该 notebook 自己的默认引用 (defaults.files
  // [<notebookId>].folders); 删的是当前主空间时 workspace 显式置 null, 让
  // runtime 退到 notebook.path (避免 folders[0] 兜底把另一个 folder 偷偷升为
  // 主空间, 与显式取消语义对齐)。 不动全局 entries (其它 notebook 可能仍在用,
  // 全局清理另走偏好设置)。
  const handleRemoveFolder = useCallback(
    async (path: string) => {
      if (!notebookId) return;
      const nextFolders = folderPaths.filter((p) => p !== path);
      const wasWorkspace = primaryFolderPath === path;
      const saved = await setDefaultFiles(notebookId, {
        workspace: wasWorkspace ? null : workspace ?? null,
        folders: nextFolders,
        notebooks: defaultFiles?.notebooks ?? [],
      });
      if (!saved) {
        toast.error(t('agent.access.saveFailed'));
        return;
      }
      const item = folderItems.find((it) => it.path === path);
      toast.success(t('agent.access.folderDeleted', { name: item?.name ?? path }));
    },
    [notebookId, primaryFolderPath, workspace, folderPaths, defaultFiles, folderItems, setDefaultFiles, t],
  );

  // 资料组 ── 外侧容器, pt-1 提供组上方留白 (与标签组对称, 用 padding 而非 margin); pb-4 是滚动列表末尾底部留白。
  return (
    <div className="pt-1 pb-4">
      <div className="agent-thread-card__access-section-label">
        {t('memo.navigation.files')}
      </div>
      <div className="space-y-0.5">
        {folderItems.map((item) => {
        const isWorkspace = primaryFolderPath === item.path;
        // 设为主空间 / 取消主空间 ── 真正的判别是 `isWorkspace`, 不是 folder
        // 个数: 单 folder 在 workspace=null 时 (用户显式取消) 也允许"设为主空间"
        // (恢复主空间标识); missing 路径永远不能当主空间, 两项均藏。
        const isWorkspaceable = !item.missing;
        const rowTitle = item.missing ? t('agent.access.pathMissing') : item.path;
        // 单击 = 在中间列打开该文件夹的文件树 (浏览), 主空间切换完全走右键
        // 菜单 ── 消除"单击切主空间"的隐藏语义。missing 行不可浏览。
        const canBrowse = !item.missing;
        const isBrowsing = canBrowse && activeFileBrowserPath === item.path;
        return (
          <ContextMenu key={item.path}>
            <ContextMenuTrigger asChild>
              <div
                role={canBrowse ? 'button' : undefined}
                tabIndex={canBrowse ? 0 : undefined}
                title={rowTitle}
                aria-label={isWorkspace ? t('agent.access.workspaceBadge') : undefined}
                aria-current={isBrowsing ? 'true' : undefined}
                onClick={
                  canBrowse
                    ? () => setActiveFileBrowserPath(item.path)
                    : undefined
                }
                onKeyDown={
                  canBrowse
                    ? (event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setActiveFileBrowserPath(item.path);
                        }
                      }
                    : undefined
                }
                className={cn(
                  'relative flex h-7 w-full select-none items-center gap-0 rounded-lg pr-2 text-left text-sm transition-[color]',
                  canBrowse && 'cursor-pointer',
                  isBrowsing
                    ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                    : 'text-[var(--foreground)]',
                  item.missing && 'opacity-70',
                )}
                style={{ paddingLeft: 6 }}
              >
                <span
                  aria-label={isWorkspace ? t('agent.access.workspaceBadge') : undefined}
                  className={cn(
                    'relative inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center -ml-1 mr-1 overflow-hidden rounded-md opacity-90',
                    isBrowsing ? 'text-[var(--primary-foreground)]' : 'text-[var(--foreground)]',
                  )}
                >
                  {item.missing ? (
                    <NotebookIcon
                      icon={null}
                      name={item.name}
                      className="h-6 w-6 rounded-md bg-[var(--muted)] text-[11px] font-semibold text-[var(--secondary-foreground)]"
                      imageClassName="h-[72%] w-[72%]"
                    />
                  ) : (
                    <Folder className="h-3.5 w-3.5" weight="fill" />
                  )}
                </span>
                <div className="flex-1 min-w-0 flex items-center gap-1.5">
                  <span className={cn('min-w-0 truncate', item.missing && 'text-[var(--muted-foreground)]')}>
                    {item.name}
                  </span>
                </div>
                {isWorkspace && (
                  <Star
                    aria-label={t('agent.access.workspaceBadge')}
                    className={cn(
                      'agent-thread-card__access-workspace-star h-3 w-3 shrink-0',
                      isBrowsing
                        ? 'text-[var(--primary-foreground)]'
                        : 'text-[var(--primary)]',
                    )}
                    fill="currentColor"
                  />
                )}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-[160px] space-y-1 px-1 py-1.5">
              {/* 设为主空间 ── 该行不是主空间 + 非 missing 时显示。
                  单 folder + workspace=null 也命中 (恢复主空间)。 */}
              {!isWorkspace && isWorkspaceable && (
                <ContextMenuItem
                  onClick={() => handleSetWorkspace(item.path)}
                  className="gap-2 rounded-md px-2 hover:bg-[var(--muted)]"
                >
                  {t('agent.access.contextSetWorkspace')}
                </ContextMenuItem>
              )}
              {/* 取消主空间 ── 该行是 workspace + 非 missing 时显示。
                  单 folder 也允许 (决策 4: 取消后 fallback 到 notebook.path)。 */}
              {isWorkspace && isWorkspaceable && (
                <ContextMenuItem
                  onClick={handleUnsetWorkspace}
                  className="gap-2 rounded-md px-2 hover:bg-[var(--muted)]"
                >
                  {t('agent.access.contextUnsetWorkspace')}
                </ContextMenuItem>
              )}
              {/* 删除 ── 与上方主空间项直接相邻, 不加分隔线 (用户偏好:
                  菜单项 look like 离散按钮而非分组列表)。 */}
              <ContextMenuItem
                onClick={() => handleRemoveFolder(item.path)}
                className="gap-2 rounded-md px-2 hover:bg-[var(--muted)] hover:text-[var(--destructive)] focus:text-[var(--destructive)]"
              >
                {t('agent.access.contextDelete')}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
        })}
        <Tooltip content={t('agent.access.addFolderHint')} side="right" align="start">
          <button
            type="button"
            onClick={handleAddFolder}
            className="group relative flex h-8 w-full cursor-pointer select-none items-center gap-0 rounded-md pr-2 text-left text-sm transition-colors text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
            style={{ paddingLeft: 6 }}
          >
            <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center -ml-1 mr-1 rounded-md text-[var(--muted-foreground)]">
              <Plus className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 flex-1 truncate">
              {t('memo.navigation.addFolder')}
            </span>
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
