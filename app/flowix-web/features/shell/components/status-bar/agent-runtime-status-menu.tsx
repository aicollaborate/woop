'use client';

import { StarFourIcon } from '@phosphor-icons/react';
import { Tooltip } from '@shared/ui/tooltip';
import { useI18n } from '@/lib/i18n';

interface AgentRuntimeStatusMenuProps {
  onOpen: () => void;
  /** 当前工作空间文件夹名 (仅用于 hover 提示)。 */
  workspaceFolderName?: string;
}

/// 状态栏的 Agents 入口 ── 点击打开 Agent 对话列表(中间列),
/// 已在该视图则 no-op。空间文件夹名通过 hover 提示展示,
/// 点击整块都触发 onOpen。
export function AgentRuntimeStatusMenu({
  onOpen,
  workspaceFolderName,
}: AgentRuntimeStatusMenuProps) {
  const { t } = useI18n();

  return (
    <Tooltip
      content={workspaceFolderName
        ? t('status.agent.workspace', { name: workspaceFolderName })
        : t('status.agent.toggleView')}
      side="top"
    >
      <button
        type="button"
        onClick={onOpen}
        className="h-full self-stretch flex items-center gap-0.5 px-1.5 py-0 hover:bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        aria-label={t('status.agent.toggleView')}
      >
        <StarFourIcon className="w-3.5 h-3.5 shrink-0" weight="regular" />
      </button>
    </Tooltip>
  );
}
