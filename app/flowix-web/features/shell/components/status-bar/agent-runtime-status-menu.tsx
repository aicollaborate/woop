'use client';

import { useMemo } from 'react';
import { StarFourIcon } from '@phosphor-icons/react';
import { Tooltip } from '@shared/ui/tooltip';
import { cn } from '@/lib/utils';
import { useAgentSessionStore } from '@features/agent/store/agent-session-store';
import {
  isAgentConversationRunning,
  useConversationRunIndex,
} from '@features/agent/store/conversation-run-index';
import { useI18n } from '@/lib/i18n';

interface AgentRuntimeStatusMenuProps {
  onOpen: () => void;
}

/// 状态栏的 Agents 入口 ── 点击打开 Agent 对话列表(中间列),
/// 已在该视图则 no-op, 已有 Agent 在跑时星标变 primary 色。
export function AgentRuntimeStatusMenu({ onOpen }: AgentRuntimeStatusMenuProps) {
  const { t } = useI18n();
  const instancesMap = useAgentSessionStore(
    (s) => s.conversationRegistry.instances,
  );
  const conversationRunIndex = useConversationRunIndex(instancesMap);
  const hasRunning = useMemo(
    () =>
      Object.values(instancesMap).some((instance) =>
        isAgentConversationRunning(instance, conversationRunIndex),
      ),
    [conversationRunIndex, instancesMap],
  );

  return (
    <Tooltip content={t('status.agent.toggleView')} side="top">
      <button
        type="button"
        onClick={onOpen}
        className="h-full self-stretch flex items-center justify-center px-1.5 py-0 hover:bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        aria-label={t('status.agent.toggleView')}
      >
        <StarFourIcon
          className={cn(
            'w-3.5 h-3.5',
            hasRunning ? 'text-[var(--primary)]' : undefined,
          )}
          weight="regular"
        />
      </button>
    </Tooltip>
  );
}