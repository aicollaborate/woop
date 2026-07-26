'use client';

import { useCallback } from 'react';
import { Folder } from '@phosphor-icons/react';
import { Plus, Trash } from 'lucide-react';
import { toast } from '@/lib/toast';
import { useAgentAccessStore } from '@features/agent/store/agent-access-store';
import { normalizeFilesDefaults } from '@/lib/agent-access-defaults';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Tooltip } from '@shared/ui/tooltip';

/**
 * 选中笔记本的"可访问文件夹"展示 ── 渲染该 notebook 下 agent 的默认
 * folders (`agent-access.defaults.files[<notebookId>].folders`, 仅取该 notebook
 * 自己的默认, 不 fallback 全局兜底), 视觉参考 agent thread card 的 access
 * popover: 复用 `agent-thread-card__access-*` 全局 CSS, 主空间行在 avatar 左上角
 * 叠三角角标。
 *
 * 空状态: 仍展示"文件"分类文案 + 「添加资料」按钮 ── 点击走全局 picker 加
 * folder, 并把它写进该 notebook 自己的默认 (空时首个 folder 兼任主空间),
 * 让文件区立即出现该 folder。 有内容时只展示 folder 行 (添加/设主空间等编辑
 * 入口仍在 agent thread card 的 access popover)。
 *
 * path 不在全局 entries (用户删了 folder 但默认仍存) 时按 missing 灰显,
 * name 取路径末段兜底。 与标签列表同处一个滚动容器 (文件在上, 标签在下)。
 */
interface NotebookAccessFilesListProps {
  notebookId: string | undefined;
}

interface ResolvedItem {
  path: string;
  name: string;
  missing: boolean;
}

export function NotebookAccessFilesList({
  notebookId,
}: NotebookAccessFilesListProps) {
  const { t } = useI18n();
  const config = useAgentAccessStore((s) => s.config);
  const addFolderFromPicker = useAgentAccessStore((s) => s.addFolderFromPicker);
  const setDefaultFiles = useAgentAccessStore((s) => s.setDefaultFiles);

  // 只展示该 notebook 自己的默认 folders, 不 fallback 全局兜底 ── 全局默认
  // 与本笔记本无关, 展示会造成混淆。 未在本笔记本的卡片里勾选过 (无
  // defaults.files[<notebookId>]) 时进入空状态。
  const defaultFiles = notebookId
    ? normalizeFilesDefaults(config?.defaults?.files)[notebookId]
    : undefined;
  const folderPaths = defaultFiles?.folders ?? [];
  const workspace = defaultFiles?.workspace;
  // Runtime resolution falls back to the first folder when no explicit
  // workspace is stored. Reflect that effective value in the badge as well.
  const effectiveWorkspace =
    workspace && folderPaths.includes(workspace) ? workspace : folderPaths[0];

  const entries = config.entries;
  const resolveItem = (path: string): ResolvedItem => {
    const found = entries.find((e) => e.kind === 'folder' && e.path === path);
    if (found) return { path, name: found.name, missing: found.missing };
    // 默认里存了 path 但全局 entries 已没有 (folder 被删): 按缺失处理,
    // name 用路径末段兜底, 让用户仍能认出是哪个目录。
    const trimmed = path.replace(/[\\/]+$/, '');
    const derived = trimmed.split(/[\\/]/).pop() || trimmed;
    return { path, name: derived, missing: true };
  };

  const folderItems = folderPaths.map(resolveItem);

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
    const comparablePath = (path: string) =>
      path.trim().replace(/[\\/]+$/, '').toLowerCase();
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

  // 点击 folder 图标切换主空间 ── 仅在「多个资料文件夹」时提供入口 (单 folder
  // 无切换对象)。点击其它 folder 可切换主空间；点击当前主空间不清空，避免
  // UI 角标与 runtime 对空 workspace 自动使用 folders[0] 的规则不一致。
  // 只写该 notebook 自己的默认 (defaults.files[<notebookId>]),
  // 与本列表只读该默认一致, 不碰全局 entries 的 workspace 标志 (那是 agent
  // thread card access popover 的职责)。 角标基于 defaultFiles.workspace,
  // 写入后随 store 订阅立即刷新。
  const handleToggleWorkspace = useCallback(
    async (path: string) => {
      if (!notebookId) return;
      // The runtime always falls back to folders[0] when workspace is empty,
      // so clearing the badge would lie about the actual cwd. Clicking the
      // active workspace is therefore a no-op; clicking another switches it.
      if (effectiveWorkspace === path) return;
      const saved = await setDefaultFiles(notebookId, {
        workspace: path,
        folders: folderPaths,
        notebooks: defaultFiles?.notebooks ?? [],
      });
      if (!saved) toast.error(t('agent.access.saveFailed'));
    },
    [notebookId, effectiveWorkspace, folderPaths, defaultFiles, setDefaultFiles, t],
  );

  // 删除资料文件夹 ── 只删该 notebook 自己的默认引用 (defaults.files
  // [<notebookId>].folders), 若它是主空间则把下一项设为主空间; 不动全局
  // entries (其它 notebook 可能仍在用, 全局清理另走偏好设置)。
  const handleRemoveFolder = useCallback(
    async (path: string) => {
      if (!notebookId) return;
      const nextFolders = folderPaths.filter((p) => p !== path);
      const saved = await setDefaultFiles(notebookId, {
        workspace: effectiveWorkspace === path ? nextFolders[0] : effectiveWorkspace,
        folders: nextFolders,
        notebooks: defaultFiles?.notebooks ?? [],
      });
      if (!saved) toast.error(t('agent.access.saveFailed'));
    },
    [notebookId, effectiveWorkspace, folderPaths, defaultFiles, setDefaultFiles, t],
  );

  // 资料组 ── 外侧容器, pt-1 提供组上方留白 (与标签组对称, 用 padding 而非 margin); pb-4 是滚动列表末尾底部留白。
  return (
    <div className="pt-1 pb-4">
      <div className="agent-thread-card__access-section-label">
        {t('memo.navigation.files')}
      </div>
      {folderItems.map((item) => {
        const isWorkspace = effectiveWorkspace === item.path;
        // 多资料文件夹时, folder 图标可点击切换主空间 (与 agent thread card
        // access popover 的 avatar 入口对齐)。 单 folder 无切换对象, missing
        // 路径不能当主空间 ── 两者都不挂交互入口, 图标仅作展示。
        const canSwitchWorkspace = folderItems.length > 1 && !item.missing;
        const iconTitle = canSwitchWorkspace
          ? isWorkspace
            ? t('agent.access.workspaceBadge')
            : t('agent.access.setWorkspace')
          : undefined;
        return (
          <Tooltip
            key={item.path}
            content={item.missing ? t('agent.access.pathMissing') : item.path}
            side="right"
            align="start"
          >
            <div
              className={cn(
                'group relative flex h-8 w-full select-none items-center gap-2 rounded-md pl-1.5 pr-2 text-left text-sm transition-colors text-[var(--foreground)]',
                item.missing && 'opacity-70',
              )}
            >
              <Tooltip content={iconTitle} side="right">
                <span
                  role={canSwitchWorkspace ? 'button' : undefined}
                  tabIndex={canSwitchWorkspace ? 0 : undefined}
                  aria-label={iconTitle}
                  onClick={
                    canSwitchWorkspace
                      ? (event) => {
                          event.stopPropagation();
                          handleToggleWorkspace(item.path);
                        }
                      : undefined
                  }
                  onKeyDown={
                    canSwitchWorkspace
                      ? (event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            event.stopPropagation();
                            handleToggleWorkspace(item.path);
                          }
                        }
                      : undefined
                  }
                  className={cn(
                    'relative flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md text-[var(--muted-foreground)]',
                    canSwitchWorkspace && 'cursor-pointer transition-colors',
                  )}
                >
                  <Folder className="h-3.5 w-3.5" weight="fill" />
                  {isWorkspace && (
                    <span
                      className="agent-thread-card__access-workspace-mark"
                      aria-hidden="true"
                    />
                  )}
                </span>
              </Tooltip>
              <div className="flex-1 min-w-0 flex items-center gap-1.5">
                <span className={cn('min-w-0 truncate', item.missing && 'text-[var(--muted-foreground)]')}>
                  {item.name}
                </span>
              </div>
              <Tooltip content={t('agent.access.deleteFolder')} side="right">
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleRemoveFolder(item.path);
                  }}
                  className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--muted-foreground)] opacity-0 transition-opacity hover:text-[var(--destructive)] group-hover:opacity-100"
                  aria-label={t('agent.access.deleteFolder')}
                >
                  <Trash className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            </div>
          </Tooltip>
        );
      })}
      <Tooltip content={t('agent.access.addFolderHint')} side="right" align="start">
        <button
          type="button"
          onClick={handleAddFolder}
          className="group relative flex h-8 w-full cursor-pointer select-none items-center gap-2 rounded-md pl-1.5 pr-2 text-left text-sm transition-colors text-[var(--muted-foreground)] hover:bg-[var(--muted)]"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)]">
            <Plus className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0 flex-1 truncate">
            {t('memo.navigation.addFolder')}
          </span>
        </button>
      </Tooltip>
    </div>
  );
}
