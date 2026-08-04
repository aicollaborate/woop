import { useEffect } from 'react';

import {
  acquireAgentChunkBridge,
  useAgentSessionStore,
} from '@features/agent/store/agent-session-store';
import { isProjectionRunActive } from '@features/agent/store/session-reducer';
import { getInterestedThreadIds } from '@features/agent/store/thread-interest';

export async function reconcileAgentRunsAndRefreshEndedHistory(): Promise<void> {
  // Canonical run state lives in AgentSessionStore projections.
  const before = useAgentSessionStore.getState();
  const locallyRunning = Object.entries(before.threadProjections)
    .filter(([, projection]) => isProjectionRunActive(projection))
    .map(([threadId]) => ({
      threadId,
      runId: before.threadProjections[threadId].runs.activeRunId,
      agentType:
        before.sessionMeta.threadTypes[threadId] ??
        before.sessionMeta.activeAgentTypeKey,
    }));

  await useAgentSessionStore.getState().reconcileRunningRuns();
  const after = useAgentSessionStore.getState();
  const endedWhileDisconnected = locallyRunning.filter(({ threadId }) => {
    const projection = after.threadProjections[threadId];
    return !projection || !isProjectionRunActive(projection);
  });

  // Tauri events are intentionally ephemeral. On startup/focus/listener
  // recovery, refresh the conversations this Webview currently owns so missed
  // user rows or stream chunks converge through the normal history API. This
  // is business-state reconciliation, not event replay.
  const refreshTargets = new Map<string, typeof after.sessionMeta.activeAgentTypeKey>();
  for (const [agentType, activeThreadId] of Object.entries(
    after.sessionMeta.activeThreadIds,
  )) {
    if (!activeThreadId) continue;
    const canonicalThreadId =
      after.sessionMeta.externalSessionResolutions[activeThreadId] ?? activeThreadId;
    refreshTargets.set(
      canonicalThreadId,
      after.sessionMeta.threadTypes[canonicalThreadId] ??
        after.sessionMeta.threadTypes[activeThreadId] ??
        (agentType as typeof after.sessionMeta.activeAgentTypeKey),
    );
  }
  for (const { threadId, agentType } of endedWhileDisconnected) {
    refreshTargets.set(threadId, agentType);
  }

  for (const interestedThreadId of getInterestedThreadIds()) {
    const canonicalThreadId =
      after.sessionMeta.externalSessionResolutions[interestedThreadId] ??
      interestedThreadId;
    refreshTargets.set(
      canonicalThreadId,
      after.sessionMeta.threadTypes[canonicalThreadId] ??
        after.sessionMeta.threadTypes[interestedThreadId] ??
        after.sessionMeta.activeAgentTypeKey,
    );
  }

  const completedTargets = new Map(
    endedWhileDisconnected
      .filter((target): target is typeof target & { runId: string } => !!target.runId)
      .map((target) => [target.threadId, target]),
  );

  await Promise.allSettled(
    [...refreshTargets].map(([threadId, agentType]) => {
      const completed = completedTargets.get(threadId);
      return completed
        ? useAgentSessionStore
            .getState()
            .reconcileCompletedRun(agentType, threadId, completed.runId)
        : useAgentSessionStore.getState().loadMessages(agentType, threadId);
    }),
  );
}

/**
 * Installs the agent stream bridge for windows that need live chat updates.
 *
 * This is mounted by AgentWindowEffects in main and tab-host windows, but not
 * preferences. The bridge itself is idempotent within each Webview realm.
 */
export function useAgentEvents(): void {
  useEffect(() => {
    let disposed = false;
    let lastReconcileAt = 0;

    const reconcileRunningRuns = async (force = false) => {
      if (disposed) return;
      const now = Date.now();
      if (!force && now - lastReconcileAt < 1000) return;
      lastReconcileAt = now;
      await reconcileAgentRunsAndRefreshEndedHistory();
    };

    const releaseAgentChunkBridge = acquireAgentChunkBridge(() => {
      // Listener readiness is a recovery boundary. Force a snapshot even if
      // the normal focus/visibility throttle ran recently, because stream_end
      // may have been missed while Tauri registration was unavailable.
      void reconcileRunningRuns(true).catch((err) => {
        console.warn('[useAgentEvents] post-listen reconciliation failed:', err);
      });
    });

    (async () => {
      try {
        await reconcileRunningRuns();
      } catch (err) {
        console.warn('[useAgentEvents] agent_running_threads failed:', err);
      }
    })();

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      void reconcileRunningRuns().catch((err) => {
        console.warn('[useAgentEvents] agent_running_threads failed:', err);
      });
    };
    const handleFocus = () => {
      void reconcileRunningRuns().catch((err) => {
        console.warn('[useAgentEvents] agent_running_threads failed:', err);
      });
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      disposed = true;
      releaseAgentChunkBridge();
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);
}
